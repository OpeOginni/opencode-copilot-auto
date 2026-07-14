import { expect, test } from "bun:test"
import { CopilotAutoPlugin } from "./index"

async function runAutoRequest(chosenModel: string, body?: Record<string, unknown>) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = []
  const original = globalThis.fetch
  const mock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const parsed = JSON.parse((await request.text()) || "{}") as Record<string, unknown>
    calls.push({ url: request.url, body: parsed, headers: request.headers })

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
      body: JSON.stringify(body ?? { model: "auto", messages: [{ role: "user", content: "Fix this bug" }] }),
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

test("converts chat completions tool schema to responses format", async () => {
  const calls = await runAutoRequest("gpt-5.4-mini", {
    model: "auto",
    messages: [{ role: "user", content: "test" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: { location: { type: "string" } } },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "get_weather" } },
  })

  const final = calls.at(-1)!
  expect(final.url).toBe("https://api.individual.githubcopilot.com/responses")
  const tools = final.body.tools as Array<Record<string, unknown>>
  expect(tools[0].name).toBe("get_weather")
  expect(tools[0].description).toBe("Get weather")
  expect(tools[0].parameters).toEqual({ type: "object", properties: { location: { type: "string" } } })
  expect(tools[0].function).toBeUndefined()
  expect(tools[0].type).toBe("function")
  const toolChoice = final.body.tool_choice as Record<string, unknown>
  expect(toolChoice.name).toBe("get_weather")
  expect(toolChoice.type).toBe("function")
  expect(toolChoice.function).toBeUndefined()
})

test("passes through tools already in responses format", async () => {
  const calls = await runAutoRequest("gpt-5.4-mini", {
    model: "auto",
    messages: [{ role: "user", content: "test" }],
    tools: [
      { type: "function", name: "get_weather", description: "Get weather", parameters: { type: "object", properties: {} } },
    ],
  })

  const final = calls.at(-1)!
  const tools = final.body.tools as Array<Record<string, unknown>>
  expect(tools[0].name).toBe("get_weather")
  expect(tools[0].function).toBeUndefined()
  expect(tools[0].type).toBe("function")
})

test("passes through string tool_choice unchanged", async () => {
  const calls = await runAutoRequest("gpt-5.4-mini", {
    model: "auto",
    messages: [{ role: "user", content: "test" }],
    tool_choice: "auto",
  })

  const final = calls.at(-1)!
  expect(final.body.tool_choice).toBe("auto")
})

test("preserves models supplied by the built-in Copilot plugin", async () => {
  const plugin = await CopilotAutoPlugin({} as never)
  const existing = { "gpt-5.4-mini": { id: "gpt-5.4-mini" } } as never
  const models = await plugin.provider!.models!({ models: existing } as never, {})

  expect(models["gpt-5.4-mini"].id).toBe("gpt-5.4-mini")
  expect(models.auto.api.id).toBe("auto")
})
