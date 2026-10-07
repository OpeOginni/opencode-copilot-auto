import { expect, test } from "bun:test"
import plugin from "../src/index.js"
import { createCopilotAuto } from "../src/sdk.js"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"

const template = {
  id: "gpt-5.4", providerID: "github-copilot", name: "GPT-5.4", family: "gpt",
  api: { id: "gpt-5.4", npm: "@ai-sdk/github-copilot", url: "https://api.githubcopilot.com", endpoint: "responses" },
  capabilities: {
    temperature: true, reasoning: true, attachment: true, toolcall: true, interleaved: false,
    input: { text: true, image: true, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
  },
  cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, output: 16_384 },
  options: {}, headers: {}, variants: {}, status: "active" as const, release_date: "",
}

export function copilotAPI(input: { chosen?: string; expiresIn?: number; failOnce?: boolean } = {}) {
  const selections: Array<Record<string, unknown>> = []
  const intents: Array<Record<string, unknown>> = []
  const requests: Array<{ url: string; body: any; headers: Headers }> = []
  let fail = input.failOnce
  const call = async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = request instanceof URL ? request.href : typeof request === "string" ? request : request.url
    const body = JSON.parse(String(init?.body ?? "{}"))
    const headers = new Headers(init?.headers)
    if (url.endsWith("/meta")) return Response.json({ auto: { tiers: ["efficiency", "balance", "intelligence"].map((id) => ({
      id, type: "auto", status: { enabled: true },
    })) } })
    if (url.endsWith("/auto")) {
      if (fail) { fail = false; return new Response("failed", { status: 500 }) }
      selections.push(body)
      return Response.json({ selected_model: { id: input.chosen ?? "gpt-5.4" }, session_token: `tier-token-${selections.length}`,
        expires_at: Math.floor(Date.now() / 1000) + (input.expiresIn ?? 600) })
    }
    if (url.endsWith("/models/session")) return Response.json({
      available_models: ["gpt-5.4", "claude-sonnet-4.5", "mai-code"], selected_model: "gpt-5.4",
      session_token: "session-token", expires_at: Math.floor(Date.now() / 1000) + 600,
    })
    if (url.endsWith("/models/session/intent")) {
      if (fail) { fail = false; return new Response("failed", { status: 500 }) }
      intents.push(body)
      return Response.json({ chosen_model: input.chosen ?? "gpt-5.4" })
    }
    requests.push({ url, body, headers })
    if (url.endsWith("/responses")) return Response.json({
      id: "resp_1", object: "response", created_at: 1, model: body.model, status: "completed",
      output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello", annotations: [] }] }],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    })
    if (url.endsWith("/chat/completions")) return Response.json({
      id: "chat_1", object: "chat.completion", created: 1, model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    })
    return new Response("unexpected", { status: 500 })
  }
  return { selections, intents, requests, call }
}

const message = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] })
const request = (text = "hello", sessionID = "ses_a", autoTier?: string): LanguageModelV3CallOptions => ({
  prompt: [message(text)], headers: { "X-Interaction-Id": sessionID, "x-initiator": "user" },
  ...(autoTier ? { providerOptions: { "github-copilot": { autoTier } } } : {}),
})

async function boot(options: Record<string, unknown> = {}, apiInput: Parameters<typeof copilotAPI>[0] = {}) {
  const toasts: unknown[] = []
  const hooks = await plugin({ client: { tui: { showToast: async (payload: unknown) => { toasts.push(payload) } } } } as never, options)
  const provider = { id: "github-copilot", models: { "gpt-5.4": template }, options: {} }
  const models = await hooks.provider!.models!(provider as never, { auth: { type: "oauth", refresh: "account-a", access: "", expires: 0 } })
  const api = copilotAPI(apiInput)
  const sdk = createCopilotAuto({ baseURL: models.auto.api.url, headers: models.auto.headers, fetch: api.call })
  return { hooks, models, api, sdk, language: sdk.languageModel("auto"), toasts }
}

test("registers Auto with a model-local SDK and V1 tier variants without changing other models", async () => {
  const { models, hooks } = await boot()
  expect(models["gpt-5.4"]).toBe(template)
  expect(models.auto).toMatchObject({ name: "Auto", family: "auto", providerID: "github-copilot",
    api: { id: "auto", url: "https://api.githubcopilot.com" }, limit: { context: 128_000, output: 16_384 },
    variants: { efficiency: { autoTier: "efficiency" }, balance: { autoTier: "balance" }, intelligence: { autoTier: "intelligence" } },
  })
  expect(models.auto.api.npm).toMatch(/^file:.*\/sdk\.js$/)
  expect(hooks.auth).toBeUndefined()
  expect(hooks.config).toBeUndefined()
  expect(hooks["command.execute.before"]).toBeUndefined()
  await hooks.dispose!()
})

test("does not invent an inventory when Copilot returned no models", async () => {
  const hooks = await plugin({} as never)
  expect(await hooks.provider!.models!({ models: {} } as never, {})).toEqual({})
})

test("plugin setup and model registration leave global fetch and its properties untouched (issue #4)", async () => {
  const original = globalThis.fetch
  const properties = Object.getOwnPropertyDescriptors(original)
  const { hooks } = await boot()
  expect(globalThis.fetch).toBe(original)
  expect(Object.getOwnPropertyDescriptors(globalThis.fetch)).toEqual(properties)
  await hooks.dispose!()
  expect(globalThis.fetch).toBe(original)
})

test("forwards session identity only for Auto", async () => {
  const { hooks, models } = await boot()
  const output: { headers: Record<string, string> } = { headers: { "x-existing": "value" } }
  await hooks["chat.headers"]!({ sessionID: "ses_b", model: models["gpt-5.4"] } as never, output)
  expect(output.headers).toEqual({ "x-existing": "value" })
  await hooks["chat.headers"]!({ sessionID: "ses_b", model: models.auto } as never, output)
  expect(output.headers).toEqual({ "x-existing": "value", "x-opencode-session-id": "ses_b" })
})

test("plain Auto routes per prompt, reuses continuations and sends native Responses", async () => {
  const { api, language } = await boot()
  await language.doGenerate(request("first"))
  await language.doGenerate({ ...request("first"), headers: { "X-Interaction-Id": "ses_a", "x-initiator": "agent" } })
  const result = await language.doGenerate(request("second"))
  expect(api.intents.map((item) => item.prompt)).toEqual(["first", "second"])
  expect(api.requests.map((item) => item.url)).toEqual(Array(3).fill("https://api.githubcopilot.com/responses"))
  expect(api.requests[1].headers.get("x-initiator")).toBe("agent")
  expect(api.requests[1].headers.get("copilot-session-token")).toBe("session-token")
  expect(api.requests[1].headers.has("x-copilot-auto-instance")).toBe(false)
  expect(result.content[0]).toMatchObject({ type: "text", text: "Hello" })
})

test("all variants use the tier endpoint and keep each model/token pair together", async () => {
  const { api, language } = await boot()
  for (const id of ["efficiency", "balance", "intelligence"]) {
    await language.doGenerate(request("same", "ses_a", id))
    await language.doGenerate(request("same", "ses_a", id))
  }
  expect(api.selections.map((item) => item.tier)).toEqual(["efficiency", "balance", "intelligence"])
  expect(api.intents).toEqual([])
  expect(api.requests.map((item) => item.headers.get("copilot-session-token"))).toEqual([
    "tier-token-1", "tier-token-1", "tier-token-2", "tier-token-2", "tier-token-3", "tier-token-3",
  ])
})

test("selected variant overrides the plugin default tier", async () => {
  const { api, language } = await boot({ tier: "efficiency" })
  await language.doGenerate(request("first"))
  await language.doGenerate(request("second", "ses_a", "intelligence"))
  expect(api.selections.map((item) => item.tier)).toEqual(["efficiency", "intelligence"])
})

test("sticky reuses a choice but reroutes on tier changes, switching back, and plain Auto", async () => {
  const { api, language } = await boot({ sticky: true })
  await language.doGenerate(request("first", "ses_a", "efficiency"))
  await language.doGenerate(request("second", "ses_a", "efficiency"))
  await language.doGenerate(request("second", "ses_a", "intelligence"))
  await language.doGenerate(request("second", "ses_a", "efficiency"))
  await language.doGenerate(request("second"))
  expect(api.selections.map((item) => [item.tier, item.prompt])).toEqual([
    ["efficiency", "first"], ["intelligence", "second"], ["efficiency", "second"],
  ])
  expect(api.intents.map((item) => item.prompt)).toEqual(["second"])
})

test("sticky decisions are isolated by session and plugin instance/account", async () => {
  const first = await boot({ sticky: true })
  const second = await boot({ sticky: true })
  await first.language.doGenerate(request("identical", "ses_a", "balance"))
  await first.language.doGenerate(request("identical", "ses_b", "balance"))
  await second.language.doGenerate(request("identical", "ses_a", "balance"))
  expect(first.api.selections).toHaveLength(2)
  expect(second.api.selections).toHaveLength(1)
})

test("concurrent calls share the tier routing decision", async () => {
  const { api, language } = await boot()
  await Promise.all(Array.from({ length: 3 }, () => language.doGenerate(request("concurrent", "ses_a", "balance"))))
  expect(api.selections).toHaveLength(1)
})

test("concurrent sticky calls refresh a near-expiry pair once", async () => {
  const { api, language } = await boot({ sticky: true }, { expiresIn: 5 })
  await language.doGenerate(request("expiry", "ses_a", "balance"))
  await Promise.all(Array.from({ length: 3 }, () => language.doGenerate(request("expiry", "ses_a", "balance"))))
  expect(api.selections).toHaveLength(2)
  expect(api.requests.map((item) => item.headers.get("copilot-session-token"))).toEqual([
    "tier-token-1", "tier-token-2", "tier-token-2", "tier-token-2",
  ])
})

test("routing errors retry on the next call, without falling back to a default tier", async () => {
  for (const selectedTier of [undefined, "balance"]) {
    const { api, language } = await boot({}, { failOnce: true })
    await expect(language.doGenerate(request("retry", "ses_a", selectedTier))).rejects.toThrow("could not select")
    await language.doGenerate(request("retry", "ses_a", selectedTier))
    expect(api.requests).toHaveLength(1)
  }
})

test("notifications are opt-in and announce only fresh decisions", async () => {
  const quiet = await boot()
  await quiet.language.doGenerate(request())
  expect(quiet.toasts).toEqual([])
  const enabled = await boot({ notifications: true, sticky: true })
  await enabled.language.doGenerate(request("first"))
  await enabled.language.doGenerate(request("second"))
  await enabled.language.doGenerate(request("third", "ses_b"))
  expect(enabled.toasts).toHaveLength(2)
  expect(enabled.toasts[0]).toMatchObject({ body: { message: "Routed to gpt-5.4", variant: "info" } })
})

test("uses native chat for GPT-4/Claude and Responses for MAI", async () => {
  for (const [chosen, path] of [["gpt-4o", "/chat/completions"], ["claude-sonnet-4.5", "/chat/completions"], ["mai-code", "/responses"]]) {
    const { api, language } = await boot({}, { chosen })
    await language.doGenerate(request())
    expect(api.requests[0].url).toBe(`https://api.githubcopilot.com${path}`)
    expect(api.requests[0].body.model).toBe(chosen)
  }
})

test("rejects invalid defaults and invalid variants", async () => {
  await expect(plugin({} as never, { tier: "fast" })).rejects.toThrow("tier must be one of")
  const { language } = await boot()
  await expect(language.doGenerate(request("hi", "ses_a", "fast"))).rejects.toThrow("tier must be one of")
})

test("disposing one plugin does not remove another registration", async () => {
  const first = await boot()
  const second = await boot()
  await first.hooks.dispose!()
  expect(() => createCopilotAuto({ headers: first.models.auto.headers })).toThrow("not registered")
  expect(createCopilotAuto({ headers: second.models.auto.headers }).chat("auto").modelId).toBe("auto")
  await second.hooks.dispose!()
})
