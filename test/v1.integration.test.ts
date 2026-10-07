import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Opt-in end-to-end test against a real V1 binary. Uses an isolated HOME,
// fake credentials and a local server; never touches the user's Copilot account.
const binary = process.env.OPENCODE_V1_BINARY
const pluginPath = process.env.OPENCODE_V1_PLUGIN ?? fileURLToPath(new URL("../dist/index.js", import.meta.url))
test.skipIf(!binary)("OpenCode V1 supports tiers alongside quota-style accounting in either plugin order", async () => {
  const base = join(tmpdir(), "opencode")
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(join(base, "copilot-auto-v1-"))
  const calls: Array<{ path: string; body: any; headers: Headers }> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = request.method === "POST" ? await request.json() : {}
      calls.push({ path, body, headers: request.headers })
      if (path === "/copilot_internal/user") return Response.json({ quota_snapshots: { premium_interactions: { remaining: 100 } } })
      if (path === "/meta") return Response.json({ auto: { tiers: [
        { id: "intelligence", type: "auto", status: { enabled: true } },
        { id: "efficiency", type: "auto", status: { enabled: true } },
      ] } })
      if (path === "/auto") return Response.json({ selected_model: { id: body.tier === "intelligence" ? "gpt-5.4" : "gpt-4.1" }, session_token: "fake-routing-token" })
      if (path === "/responses") return new Response([
        { type: "response.created", response: { id: "resp_1", created_at: 1, model: "gpt-5.4" } },
        { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
        { type: "response.output_text.delta", item_id: "msg_1", delta: "V1 smoke works" },
        { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1" } },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
      if (path === "/chat/completions") return new Response([
        `data: ${JSON.stringify({ id: "chat_1", object: "chat.completion.chunk", created: 1, model: "gpt-4.1",
          choices: [{ index: 0, delta: { role: "assistant", content: "V1 smoke works" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "chat_1", object: "chat.completion.chunk", created: 1, model: "gpt-4.1",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } })
      return new Response("unexpected", { status: 500 })
    },
  })
  try {
    const config = join(directory, "opencode.json")
    const accounting = join(directory, "quota-probe.js")
    await writeFile(accounting, `
      const original = globalThis.fetch;
      const query = async () => {
        if (globalThis.fetch !== original) throw new Error("Global fetch replaced");
        const response = await fetch(${JSON.stringify(server.url.origin + "/copilot_internal/user")}, { signal: AbortSignal.timeout(5000) });
        const quota = await response.json();
        if (quota.quota_snapshots.premium_interactions.remaining !== 100) throw new Error("Accounting failed");
      };
      export default async () => {
        await query();
        return { "chat.headers": async () => { await query(); } };
      };
    `)
    const auto = [pluginPath, { sticky: true }]
    for (const [plugins, selectedTier, path, chosen] of [
      [[accounting, auto], "efficiency", "/chat/completions", "gpt-4.1"],
      [[auto, accounting], "intelligence", "/responses", "gpt-5.4"],
    ] as const) {
      calls.length = 0
      await writeFile(config, JSON.stringify({
        plugin: plugins,
        provider: { "github-copilot": { options: { baseURL: server.url.origin, apiKey: "fake-api-key" } } },
        small_model: "github-copilot/gpt-4.1",
        permission: { "*": "deny" },
      }))
      const child = Bun.spawn([binary!, "--print-logs", "run", "--model", "github-copilot/auto", "--variant", selectedTier, "Say hello"], {
        cwd: directory,
        env: {
          PATH: process.env.PATH!, HOME: directory,
          XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"),
          XDG_CACHE_HOME: join(directory, "cache"), XDG_STATE_HOME: join(directory, "state"),
          OPENCODE_CONFIG: config, OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_AUTOUPDATE: "true",
          OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
        },
        stdout: "pipe", stderr: "pipe",
      })
      const timer = setTimeout(() => child.kill(), 45_000)
      try {
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ])
        expect({ stdout, stderr, exit }).toMatchObject({ exit: 0 })
        expect(stdout).toContain("V1 smoke works")
        expect(calls.filter((call) => call.path === "/copilot_internal/user").length).toBeGreaterThanOrEqual(2)
        expect(calls.filter((call) => call.path === "/auto").map((call) => ({ prompt: call.body.prompt, tier: call.body.tier })))
          .toContainEqual({ prompt: '"Say hello"', tier: selectedTier })
        const modelCall = calls.find((call) => call.path === path && call.headers.has("copilot-session-token"))
        expect(modelCall?.body.model).toBe(chosen)
        expect(modelCall?.headers.get("copilot-session-token")).toBe("fake-routing-token")
        expect(modelCall?.headers.has("x-copilot-auto-instance")).toBe(false)
        expect(modelCall?.body.autoTier).toBeUndefined()
      } finally {
        clearTimeout(timer)
        child.kill()
        await child.exited
      }
    }
  } finally {
    server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)
