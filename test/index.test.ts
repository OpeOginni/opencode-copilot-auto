import { expect, test } from "bun:test"
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import plugin from "../src/index.js"

type Callback = (event: any) => Promise<void> | void

function fakeContext(options: Record<string, unknown> = {}) {
  const transforms: Array<(editor: any) => void> = []
  const hooks: Record<string, Callback[]> = {}
  const emitted: Array<{ event: string; data: unknown }> = []
  let registered = false
  const register = (name: string) => async (callback: Callback) => {
    ;(hooks[name] ??= []).push(callback)
    return { dispose: async () => {} }
  }
  const ctx = {
    options,
    provider: {
      transform: async (callback: (editor: any) => void) => {
        transforms.push(callback)
        return { dispose: async () => {} }
      },
    },
    session: { hook: (name: string, callback: Callback) => register(`session.${name}`)(callback) },
    aisdk: { hook: (name: string, callback: Callback) => register(`aisdk.${name}`)(callback) },
    rpc: {
      register: async () => {
        registered = true
        return {
          dispose: async () => {},
          events: {
            emit: async (event: string, data: unknown) => {
              emitted.push({ event, data })
            },
          },
        }
      },
    },
  }
  const emit = async (name: string, event: unknown) => {
    for (const callback of hooks[name] ?? []) await callback(event)
  }
  return { ctx, transforms, hooks, emit, emitted, rpcRegistered: () => registered }
}

function fakeEditor(models: Array<Record<string, unknown>>, connected = true) {
  const updates: Array<{ providerID: string; modelID: string; draft: Record<string, any> }> = []
  const record = {
    provider: { id: "github-copilot" },
    models: new Map(models.map((model) => [model.id as string, model])),
    ...(connected ? { sourceConnection: { id: "con_1", integrationID: "github-copilot" } } : {}),
  }
  return {
    updates,
    editor: {
      get: (id: string) => (id === "github-copilot" ? record : undefined),
      models: {
        update: (providerID: string, modelID: string, update: (draft: Record<string, any>) => void) => {
          const draft: Record<string, any> = {}
          update(draft)
          updates.push({ providerID, modelID, draft })
        },
      },
    },
  }
}

const copilotModels = [
  {
    id: "claude-sonnet-4.5",
    package: "@opencode/ai/providers/anthropic",
    settings: { baseURL: "https://api.individual.githubcopilot.com/v1", endpoint: "messages" },
  },
  {
    id: "gpt-5.4",
    package: "aisdk:@ai-sdk/github-copilot",
    settings: { baseURL: "https://api.individual.githubcopilot.com", endpoint: "responses" },
  },
  { id: "gpt-4.1", package: "aisdk:@ai-sdk/github-copilot", settings: { baseURL: "https://api.individual.githubcopilot.com" } },
]

function copilotAPI(chosen: (prompt: string) => string, expiresIn?: number) {
  const intents: string[] = []
  const selections: Array<{ prompt: string; tier: string; token: string }> = []
  const fetch = async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = request instanceof URL ? request.href : typeof request === "string" ? request : request.url
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    if (url.endsWith("/meta")) {
      return Response.json({ auto: { tiers: ["efficiency", "balance", "intelligence"].map((id) => ({
        id, type: "auto", status: { enabled: true },
      })) } })
    }
    if (url.endsWith("/auto")) {
      const token = `tier-token-${selections.length + 1}`
      selections.push({ prompt: body.prompt as string, tier: body.tier as string, token })
      return Response.json({
        selected_model: { id: chosen(body.prompt as string) }, session_token: token,
        ...(expiresIn === undefined ? {} : { expires_at: Math.floor(Date.now() / 1000) + expiresIn }),
      })
    }
    if (url.endsWith("/models/session")) {
      return Response.json({
        available_models: ["gpt-5.4", "gpt-4.1", "claude-sonnet-4.5"],
        selected_model: "gpt-4.1",
        session_token: "session-token",
        expires_at: Math.floor(Date.now() / 1000) + 600,
      })
    }
    if (url.endsWith("/models/session/intent")) {
      intents.push(body.prompt as string)
      return Response.json({ chosen_model: chosen(body.prompt as string) })
    }
    return new Response("unexpected", { status: 500 })
  }
  return { intents, selections, fetch }
}

function fakeSDK() {
  const created: string[] = []
  const calls: LanguageModelV3CallOptions[] = []
  const make = (endpoint: string) => (model: string): LanguageModelV3 => {
    created.push(`${endpoint}:${model}`)
    return {
      specificationVersion: "v3",
      provider: "github-copilot",
      modelId: model,
      supportedUrls: {},
      async doGenerate() {
        throw new Error("unused")
      },
      async doStream(options) {
        calls.push(options)
        return { stream: new ReadableStream() }
      },
    }
  }
  return { sdk: { chat: make("chat"), responses: make("responses") }, created, calls }
}

const message = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] })

async function boot(input: { sticky?: boolean; notifications?: boolean; tier?: string; expiresIn?: number; chosen?: (prompt: string) => string } = {}) {
  const context = fakeContext({
    ...(input.sticky === undefined ? {} : { sticky: input.sticky }),
    ...(input.notifications === undefined ? {} : { notifications: input.notifications }),
    ...(input.tier === undefined ? {} : { tier: input.tier }),
  })
  await plugin.setup(context.ctx as never)
  const api = copilotAPI(input.chosen ?? (() => "gpt-5.4"), input.expiresIn)
  const fake = fakeSDK()
  const event = {
    model: { providerID: "github-copilot", id: "auto" },
    sdk: fake.sdk,
    options: { baseURL: "https://api.individual.githubcopilot.com", apiKey: "gho_token", fetch: api.fetch },
    language: undefined as LanguageModelV3 | undefined,
  }
  const editor = fakeEditor(copilotModels)
  for (const transform of context.transforms) transform(editor.editor)
  await context.emit("aisdk.language", event)
  if (!event.language) throw new Error("language model was not installed")
  const variant = async (autoTier?: string, apiKey = "gho_token") => {
    const selected = { ...event, options: { ...event.options, apiKey, ...(autoTier ? { autoTier } : {}) }, language: undefined as LanguageModelV3 | undefined }
    await context.emit("aisdk.language", selected)
    return selected.language!
  }
  return { context, api, fake, editor, language: event.language, variant }
}

test("adds an Auto model cloned from the connected Copilot inventory", async () => {
  const { editor } = await boot()
  expect(editor.updates).toHaveLength(1)
  expect(editor.updates[0]).toMatchObject({ providerID: "github-copilot", modelID: "auto" })
  expect(editor.updates[0].draft).toEqual({
    name: "Auto",
    package: "aisdk:@ai-sdk/github-copilot",
    settings: { baseURL: "https://api.individual.githubcopilot.com", endpoint: "chat" },
    variants: ["efficiency", "balance", "intelligence"].map((id) => ({ id, settings: { autoTier: id } })),
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    limit: { context: 128_000, output: 16_384 },
    enabled: true,
  })
})

test("does not add Auto until the user has authenticated Copilot", async () => {
  const context = fakeContext()
  await plugin.setup(context.ctx as never)
  // Disconnected: the static models.dev inventory is still present, but not bound to a connection.
  const editor = fakeEditor(copilotModels, false)
  for (const transform of context.transforms) transform(editor.editor)
  expect(editor.updates).toHaveLength(0)
})

test("does not add Auto when Copilot returned no models", async () => {
  const context = fakeContext()
  await plugin.setup(context.ctx as never)
  const editor = fakeEditor([])
  for (const transform of context.transforms) transform(editor.editor)
  expect(editor.updates).toHaveLength(0)
})

test("ignores other models and unknown SDKs", async () => {
  const context = fakeContext()
  await plugin.setup(context.ctx as never)
  const other = { model: { providerID: "github-copilot", id: "gpt-5.4" }, sdk: fakeSDK().sdk, options: {}, language: undefined }
  const unknown = { model: { providerID: "github-copilot", id: "auto" }, sdk: { languageModel() {} }, options: {}, language: undefined }
  await context.emit("aisdk.language", other)
  await context.emit("aisdk.language", unknown)
  expect(other.language).toBeUndefined()
  expect(unknown.language).toBeUndefined()
})

test("routes each request using the advertised endpoint and session token", async () => {
  const { api, fake, language } = await boot({ chosen: (prompt) => (prompt.includes("plan") ? "claude-sonnet-4.5" : "gpt-5.4") })

  await language.doStream({ prompt: [message("write a plan")] })
  await language.doStream({ prompt: [message("write a plan")], headers: { "x-initiator": "agent" } })
  await language.doStream({ prompt: [message("now implement it")] })

  expect(api.intents).toEqual(["write a plan", "now implement it"])
  expect(fake.created).toEqual(["chat:claude-sonnet-4.5", "chat:claude-sonnet-4.5", "responses:gpt-5.4"])
  expect(fake.calls[1].headers).toEqual({ "x-initiator": "agent", "copilot-session-token": "session-token" })
})

test("sticky keeps the first routed model for the whole session", async () => {
  const { context, api, fake, language } = await boot({ sticky: true })
  const primary = { providerID: "github-copilot", id: "auto" }

  await context.emit("session.context", { sessionID: "ses_a", model: primary, messages: [message("first")] })
  await language.doStream({ prompt: [message("first")] })
  await context.emit("session.context", { sessionID: "ses_a", model: primary, messages: [message("first"), message("second")] })
  await language.doStream({ prompt: [message("first"), message("second")] })
  await context.emit("session.context", { sessionID: "ses_b", model: primary, messages: [message("elsewhere")] })
  await language.doStream({ prompt: [message("elsewhere")] })

  expect(api.intents).toEqual(["first", "elsewhere"])
  expect(fake.created).toEqual(["responses:gpt-5.4", "responses:gpt-5.4", "responses:gpt-5.4"])
})

test("sticky ignores sessions running other models", async () => {
  const { context, api, language } = await boot({ sticky: true })

  await context.emit("session.context", {
    sessionID: "ses_other",
    model: { providerID: "github-copilot", id: "gpt-5.4" },
    messages: [message("hello")],
  })
  await language.doStream({ prompt: [message("hello")] })
  await language.doStream({ prompt: [message("hello again")] })

  expect(api.intents).toEqual(["hello", "hello again"])
})

test("notifications are off by default", async () => {
  const { context, language } = await boot()
  await language.doStream({ prompt: [message("quiet")] })
  expect(context.rpcRegistered()).toBe(false)
  expect(context.emitted).toEqual([])
})

test("notifications announce every fresh routing decision", async () => {
  const { context, language } = await boot({ notifications: true })
  const primary = { providerID: "github-copilot", id: "auto" }

  await context.emit("session.context", { sessionID: "ses_a", model: primary, messages: [message("one")] })
  await language.doStream({ prompt: [message("one")] })
  await language.doStream({ prompt: [message("one")] }) // tool continuation, same prompt
  await context.emit("session.context", { sessionID: "ses_a", model: primary, messages: [message("one"), message("two")] })
  await language.doStream({ prompt: [message("one"), message("two")] })

  expect(context.emitted).toEqual([
    { event: "routed", data: { model: "gpt-5.4", sessionID: "ses_a" } },
    { event: "routed", data: { model: "gpt-5.4", sessionID: "ses_a" } },
  ])
})

test("notifications announce once per session when sticky", async () => {
  const { context, language } = await boot({ notifications: true, sticky: true })
  const primary = { providerID: "github-copilot", id: "auto" }

  await context.emit("session.context", { sessionID: "ses_a", model: primary, messages: [message("one")] })
  await language.doStream({ prompt: [message("one")] })
  await context.emit("session.context", { sessionID: "ses_a", model: primary, messages: [message("one"), message("two")] })
  await language.doStream({ prompt: [message("one"), message("two")] })

  expect(context.emitted).toEqual([{ event: "routed", data: { model: "gpt-5.4", sessionID: "ses_a" } }])
})

test("a failed route is retried on the next call", async () => {
  const api = copilotAPI(() => "gpt-5.4")
  let fail = true
  const original = api.fetch
  const flaky = async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = request instanceof URL ? request.href : typeof request === "string" ? request : request.url
    if (fail && url.endsWith("/models/session/intent")) {
      fail = false
      return new Response("boom", { status: 500 })
    }
    return original(request, init)
  }
  const context = fakeContext()
  await plugin.setup(context.ctx as never)
  const editor = fakeEditor(copilotModels)
  for (const transform of context.transforms) transform(editor.editor)
  const fake = fakeSDK()
  const event = {
    model: { providerID: "github-copilot", id: "auto" },
    sdk: fake.sdk,
    options: { baseURL: "https://api.individual.githubcopilot.com", fetch: flaky },
    language: undefined as LanguageModelV3 | undefined,
  }
  await context.emit("aisdk.language", event)

  expect(event.language!.doStream({ prompt: [message("retry me")] })).rejects.toThrow("could not select a model")
  await event.language!.doStream({ prompt: [message("retry me")] })
  expect(fake.created).toEqual(["responses:gpt-5.4"])
})

test("each Auto variant routes with its own model/token pair and reuses tool continuations", async () => {
  const { api, fake, variant } = await boot()
  for (const id of ["efficiency", "balance", "intelligence"]) {
    const language = await variant(id)
    await language.doStream({ prompt: [message("same prompt")], headers: { "X-Interaction-Id": "ses_a" } })
    await language.doStream({ prompt: [message("same prompt")], headers: { "X-Interaction-Id": "ses_a" } })
  }
  expect(api.selections.map((selection) => selection.tier)).toEqual(["efficiency", "balance", "intelligence"])
  expect(api.intents).toEqual([])
  expect(fake.calls.map((call) => call.headers?.["copilot-session-token"])).toEqual([
    "tier-token-1", "tier-token-1", "tier-token-2", "tier-token-2", "tier-token-3", "tier-token-3",
  ])
})

test("a selected variant overrides the plugin's default tier", async () => {
  const { api, language, variant } = await boot({ tier: "efficiency" })
  await language.doStream({ prompt: [message("default")] })
  await (await variant("intelligence")).doStream({ prompt: [message("override")] })
  expect(api.selections.map((selection) => selection.tier)).toEqual(["efficiency", "intelligence"])
})

test("sticky reroutes on tier changes, including switching back and returning to plain Auto", async () => {
  const { api, variant } = await boot({ sticky: true })
  const efficiency = await variant("efficiency")
  const intelligence = await variant("intelligence")
  const plain = await variant()
  const run = (language: LanguageModelV3, text: string) => language.doStream({
    prompt: [message(text)], headers: { "X-Interaction-Id": "ses_a" },
  })
  await run(efficiency, "first")
  await run(efficiency, "second")
  await run(intelligence, "second")
  await run(efficiency, "second")
  await run(plain, "second")
  expect(api.selections.map((selection) => [selection.tier, selection.prompt])).toEqual([
    ["efficiency", "first"], ["intelligence", "second"], ["efficiency", "second"],
  ])
  expect(api.intents).toEqual(["second"])
})

test("tier decisions are isolated by session and account, even for identical prompts", async () => {
  const { api, variant } = await boot({ sticky: true })
  const first = await variant("balance", "account-a")
  const second = await variant("balance", "account-b")
  for (const [language, sessionID] of [[first, "ses_a"], [first, "ses_b"], [second, "ses_a"]] as const) {
    await language.doStream({ prompt: [message("identical")], headers: { "X-Interaction-Id": sessionID } })
  }
  expect(api.selections).toHaveLength(3)
})

test("concurrent calls share a tier routing decision", async () => {
  const { api, variant } = await boot()
  const language = await variant("balance")
  await Promise.all(Array.from({ length: 3 }, () => language.doStream({ prompt: [message("concurrent")] })))
  expect(api.selections).toHaveLength(1)
})

test("invalid plugin tiers fail clearly", async () => {
  await expect(boot({ tier: "fast" })).rejects.toThrow("tier must be one of")
})

test("concurrent sticky calls refresh a near-expiry tier model/token pair once", async () => {
  const { api, fake, variant } = await boot({ sticky: true, expiresIn: 5 })
  const language = await variant("balance")
  const run = () => language.doStream({ prompt: [message("expiry")], headers: { "X-Interaction-Id": "ses_a" } })
  await run()
  await Promise.all([run(), run(), run()])
  expect(api.selections).toHaveLength(2)
  expect(fake.calls.map((call) => call.headers?.["copilot-session-token"])).toEqual([
    "tier-token-1", "tier-token-2", "tier-token-2", "tier-token-2",
  ])
})
