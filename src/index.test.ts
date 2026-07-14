import { expect, test } from "bun:test"
import { CopilotAutoPlugin } from "./index"

async function runAutoRequest(chosenModel: string) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = []
  const original = globalThis.fetch
  const mock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const body = JSON.parse((await request.text()) || "{}") as Record<string, unknown>
    calls.push({ url: request.url, body, headers: request.headers })

    if (request.url.endsWith("/models/session")) {
      return Response.json({
        available_models: ["gpt-5.4-mini", "claude-haiku-4.5"],
        selected_model: chosenModel,
        session_token: "session-token",
        expires_at: Math.floor(Date.now() / 1000) + 60,
      })
    }
    if (request.url.endsWith("/models/session/intent")) return Response.json({ chosen_model: chosenModel })
    return Response.json({ choices: [] })
  }

  globalThis.fetch = Object.assign(mock, original)
  const marker = Symbol.for("opeoginni.opencode-copilot-auto.fetch-adapter")
  delete (globalThis as typeof globalThis & { [marker]?: true })[marker]
  await CopilotAutoPlugin({} as never)

  try {
    await fetch("https://api.individual.githubcopilot.com/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "Fix this bug" }] }),
    })
  } finally {
    globalThis.fetch = original
  }

  return calls
}

test("rewrites GPT auto requests to /responses", async () => {
  const calls = await runAutoRequest("gpt-5.4-mini")
  const final = calls.at(-1)!
  expect(final.url).toBe("https://api.individual.githubcopilot.com/responses")
  expect(final.body.model).toBe("gpt-5.4-mini")
  expect(final.body.messages).toBeUndefined()
  expect(final.body.input).toBe("Fix this bug")
  expect(final.headers.get("copilot-session-token")).toBe("session-token")
})

test("keeps non-GPT auto requests on /chat/completions", async () => {
  const calls = await runAutoRequest("claude-haiku-4.5")
  const final = calls.at(-1)!
  expect(final.url).toBe("https://api.individual.githubcopilot.com/chat/completions")
  expect(final.body.model).toBe("claude-haiku-4.5")
  expect(final.headers.get("copilot-session-token")).toBe("session-token")
})

test("preserves models supplied by the built-in Copilot plugin", async () => {
  const plugin = await CopilotAutoPlugin({} as never)
  const existing = { "gpt-5.4-mini": { id: "gpt-5.4-mini" } } as never
  const models = await plugin.provider!.models!({ models: existing } as never, {})

  expect(models["gpt-5.4-mini"].id).toBe("gpt-5.4-mini")
  expect(models.auto.api.id).toBe("auto")
})
