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

test("converts GPT auto requests to /responses with full conversation history", async () => {
  const calls = await runAutoRequest("gpt-5.4-mini", {
    model: "auto",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "How are you?" },
    ],
  })
  const final = calls.at(-1)!
  expect(final.url).toBe("https://api.individual.githubcopilot.com/responses")
  expect(final.body.model).toBe("gpt-5.4-mini")
  expect(final.body.messages).toBeUndefined()
  expect(final.body.instructions).toBe("You are helpful.")
  expect(final.body.input).toEqual([
    { role: "user", content: [{ type: "input_text", text: "Hello" }] },
    { role: "assistant", content: [{ type: "output_text", text: "Hi there" }] },
    { role: "user", content: [{ type: "input_text", text: "How are you?" }] },
  ])
  expect(final.headers.get("copilot-session-token")).toBe("session-token")
})

test("converts tool calls in conversation history", async () => {
  const calls = await runAutoRequest("gpt-5.3-codex", {
    model: "auto",
    messages: [
      { role: "user", content: "What is the weather?" },
      {
        role: "assistant",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"location":"NYC"}' },
        }],
      },
      { role: "tool", tool_call_id: "call_1", content: "72F sunny" },
    ],
    tools: [{
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object", properties: {} },
      },
    }],
  })
  const final = calls.at(-1)!
  expect(final.url).toBe("https://api.individual.githubcopilot.com/responses")
  const input = final.body.input as unknown[]
  expect(input).toContainEqual({ type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"location":"NYC"}' })
  expect(input).toContainEqual({ type: "function_call_output", call_id: "call_1", output: "72F sunny" })
  const tools = final.body.tools as Array<Record<string, unknown>>
  expect(tools[0].name).toBe("get_weather")
  expect(tools[0].function).toBeUndefined()
  expect(tools[0].type).toBe("function")
})

test("keeps non-GPT auto requests on /chat/completions", async () => {
  const calls = await runAutoRequest("claude-haiku-4.5")
  const final = calls.at(-1)!
  expect(final.url).toBe("https://api.individual.githubcopilot.com/chat/completions")
  expect(final.body.model).toBe("claude-haiku-4.5")
  expect(final.headers.get("copilot-session-token")).toBe("session-token")
})

test("transforms Responses API SSE to Chat Completions SSE", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown>; response?: Response }> = []
  const original = globalThis.fetch
  const sseBody = [
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" world"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{}}\n\n',
  ].join("")

  const mock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const parsed = JSON.parse((await request.text()) || "{}") as Record<string, unknown>
    calls.push({ url: request.url, body: parsed })

    if (request.url.endsWith("/models/session")) {
      return Response.json({
        available_models: ["gpt-5.4-mini"],
        selected_model: "gpt-5.4-mini",
        session_token: "session-token",
        expires_at: Math.floor(Date.now() / 1000) + 60,
      })
    }
    if (request.url.endsWith("/models/session/intent")) return Response.json({ chosen_model: "gpt-5.4-mini" })
    if (request.url.endsWith("/responses")) {
      return new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    }
    return Response.json({ choices: [] })
  }

  globalThis.fetch = Object.assign(mock, original)
  const marker = Symbol.for("opeoginni.opencode-copilot-auto.fetch-adapter")
  delete (globalThis as typeof globalThis & { [marker]?: true })[marker]
  await CopilotAutoPlugin({} as never)

  let response: Response | undefined
  try {
    response = await fetch("https://api.individual.githubcopilot.com/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "Hi" }] }),
    })
  } finally {
    globalThis.fetch = original
  }

  expect(response).toBeDefined()
  const text = await response!.text()
  const chunks = text.split("\n\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
  expect(chunks.length).toBe(3)

  const first = JSON.parse(chunks[0].slice(6))
  expect(first.object).toBe("chat.completion.chunk")
  expect(first.choices[0].delta.content).toBe("Hello")

  const second = JSON.parse(chunks[1].slice(6))
  expect(second.choices[0].delta.content).toBe(" world")

  const done = JSON.parse(chunks[2].slice(6))
  expect(done.choices[0].finish_reason).toBe("stop")

  expect(text).toContain("data: [DONE]")
})

test("preserves models supplied by the built-in Copilot plugin", async () => {
  const plugin = await CopilotAutoPlugin({} as never)
  const existing = { "gpt-5.4-mini": { id: "gpt-5.4-mini" } } as never
  const models = await plugin.provider!.models!({ models: existing } as never, {})

  expect(models["gpt-5.4-mini"].id).toBe("gpt-5.4-mini")
  expect(models.auto.api.id).toBe("auto")
})
