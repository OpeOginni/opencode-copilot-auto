import { expect, test } from "bun:test"
import { CopilotAutoPlugin } from "./index"

async function runAutoRequest(chosenModel: string, body?: Record<string, unknown>, path = "chat/completions") {
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
    await fetch(`https://api.individual.githubcopilot.com/${path}`, {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify(body ?? { model: "auto", messages: [{ role: "user", content: "Fix this bug" }] }),
    })
  } finally {
    globalThis.fetch = original
  }

  return calls
}

async function runAutoRequestWithResponse(chosenModel: string, sseBody: string) {
  const original = globalThis.fetch
  const mock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    await request.text()

    if (request.url.endsWith("/models/session")) {
      return Response.json({
        available_models: ["gpt-5.4-mini"],
        selected_model: chosenModel,
        session_token: "session-token",
        expires_at: Math.floor(Date.now() / 1000) + 60,
      })
    }
    if (request.url.endsWith("/models/session/intent")) return Response.json({ chosen_model: chosenModel })
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

  try {
    return await fetch("https://api.individual.githubcopilot.com/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "Hi" }] }),
    })
  } finally {
    globalThis.fetch = original
  }
}

function parseChunks(text: string) {
  return text
    .split("\n\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => JSON.parse(l.slice(6)))
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

test("flattens tool_choice from Chat Completions to Responses format", async () => {
  const calls = await runAutoRequest("gpt-5.4-mini", {
    model: "auto",
    messages: [{ role: "user", content: "test" }],
    tools: [{ type: "function", function: { name: "x", description: "", parameters: {} } }],
    tool_choice: { type: "function", function: { name: "x" } },
  })
  const final = calls.at(-1)!
  const toolChoice = final.body.tool_choice as Record<string, unknown>
  expect(toolChoice.name).toBe("x")
  expect(toolChoice.type).toBe("function")
  expect(toolChoice.function).toBeUndefined()
})

test("converts messages with array content", async () => {
  const calls = await runAutoRequest("gpt-5.4-mini", {
    model: "auto",
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }] },
    ],
  })
  const final = calls.at(-1)!
  const input = final.body.input as Array<{ content: Array<{ text: string }> }>
  expect(input[0].content[0].text).toBe("hello\nworld")
})

test("preserves native Responses input", async () => {
  const calls = await runAutoRequest("gpt-5.4-mini", {
    model: "auto",
    input: "Explain this",
    instructions: "Be concise.",
  }, "responses")
  const final = calls.at(-1)!
  expect(final.url).toBe("https://api.individual.githubcopilot.com/responses")
  expect(final.body.input).toBe("Explain this")
  expect(final.body.instructions).toBe("Be concise.")
})

test("keeps non-GPT auto requests on /chat/completions", async () => {
  const calls = await runAutoRequest("claude-haiku-4.5")
  const final = calls.at(-1)!
  expect(final.url).toBe("https://api.individual.githubcopilot.com/chat/completions")
  expect(final.body.model).toBe("claude-haiku-4.5")
  expect(final.headers.get("copilot-session-token")).toBe("session-token")
})

test("sets X-GitHub-Api-Version on main request", async () => {
  const calls = await runAutoRequest("gpt-5.4-mini")
  const final = calls.at(-1)!
  expect(final.headers.get("X-GitHub-Api-Version")).toBe("2026-07-01")
})

test("passes through non-auto requests unchanged", async () => {
  const original = globalThis.fetch
  let intercepted = false
  const mock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.url.endsWith("/chat/completions")) intercepted = true
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
      body: JSON.stringify({ model: "gpt-5.4-mini", messages: [{ role: "user", content: "Hi" }] }),
    })
  } finally {
    globalThis.fetch = original
  }

  expect(intercepted).toBe(true)
})

test("transforms Responses API SSE to Chat Completions SSE", async () => {
  const sseBody = [
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" world"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{}}\n\n',
  ].join("")

  const response = await runAutoRequestWithResponse("gpt-5.4-mini", sseBody)
  const text = await response.text()
  const chunks = parseChunks(text)

  expect(chunks.length).toBe(3)
  expect(chunks[0].object).toBe("chat.completion.chunk")
  expect(chunks[0].choices[0].delta.content).toBe("Hello")
  expect(chunks[1].choices[0].delta.content).toBe(" world")
  expect(chunks[2].choices[0].finish_reason).toBe("stop")
  expect(text).toContain("data: [DONE]")
})

test("converts non-streaming Responses JSON to Chat Completions JSON", async () => {
  const original = globalThis.fetch
  const mock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    await request.text()
    if (request.url.endsWith("/models/session")) {
      return Response.json({ available_models: ["gpt-5.4-mini"], selected_model: "gpt-5.4-mini", session_token: "session-token", expires_at: Math.floor(Date.now() / 1000) + 60 })
    }
    if (request.url.endsWith("/models/session/intent")) return Response.json({ chosen_model: "gpt-5.4-mini" })
    return Response.json({ id: "resp_1", created_at: 1, model: "gpt-5.4-mini", output: [{ type: "message", content: [{ type: "output_text", text: "Hello" }] }] })
  }
  globalThis.fetch = Object.assign(mock, original)
  const marker = Symbol.for("opeoginni.opencode-copilot-auto.fetch-adapter")
  delete (globalThis as typeof globalThis & { [marker]?: true })[marker]
  await CopilotAutoPlugin({} as never)
  try {
    const response = await fetch("https://api.individual.githubcopilot.com/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer non-streaming", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "Hi" }] }),
    })
    const data = await response.json() as { object: string; choices: Array<{ message: { content: string } }> }
    expect(data.object).toBe("chat.completion")
    expect(data.choices[0].message.content).toBe("Hello")
  } finally {
    globalThis.fetch = original
  }
})

test("emits an error and terminal marker for failed Responses streams", async () => {
  const response = await runAutoRequestWithResponse("gpt-5.4-mini", [
    'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"Upstream failed"}}}\n\n',
  ].join(""))
  const text = await response.text()
  expect(text).toContain('"message":"Upstream failed"')
  expect(text).toContain("data: [DONE]")
})

test("transforms Responses API tool call SSE to Chat Completions tool call SSE", async () => {
  const sseBody = [
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_42","name":"get_weather"}}\n\n',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"{\\"loc"}\n\n',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"ation\\":\\"NYC\\"}"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{}}\n\n',
  ].join("")

  const response = await runAutoRequestWithResponse("gpt-5.4-mini", sseBody)
  const text = await response.text()
  const chunks = parseChunks(text)

  expect(chunks.length).toBe(4)

  const callStart = chunks[0]
  expect(callStart.choices[0].delta.tool_calls[0].id).toBe("call_42")
  expect(callStart.choices[0].delta.tool_calls[0].function.name).toBe("get_weather")
  expect(callStart.choices[0].delta.tool_calls[0].function.arguments).toBe("")
  expect(callStart.choices[0].delta.tool_calls[0].index).toBe(0)

  const arg1 = chunks[1]
  expect(arg1.choices[0].delta.tool_calls[0].function.arguments).toBe('{"loc')

  const arg2 = chunks[2]
  expect(arg2.choices[0].delta.tool_calls[0].function.arguments).toBe('ation":"NYC"}')

  expect(chunks[3].choices[0].finish_reason).toBe("stop")
  expect(text).toContain("data: [DONE]")
})

test("reuses cached session on second request", async () => {
  const calls: Array<{ url: string }> = []
  const original = globalThis.fetch
  const mock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    await request.text()
    calls.push({ url: request.url })

    if (request.url.endsWith("/models/session")) {
      return Response.json({
        available_models: ["gpt-5.4-mini"],
        selected_model: "gpt-5.4-mini",
        session_token: "session-token",
        expires_at: Math.floor(Date.now() / 1000) + 60,
      })
    }
    if (request.url.endsWith("/models/session/intent")) return Response.json({ chosen_model: "gpt-5.4-mini" })
    return Response.json({ choices: [] })
  }

  globalThis.fetch = Object.assign(mock, original)
  const marker = Symbol.for("opeoginni.opencode-copilot-auto.fetch-adapter")
  delete (globalThis as typeof globalThis & { [marker]?: true })[marker]
  await CopilotAutoPlugin({} as never)

  const auth = "Bearer test-caching-token"
  try {
    await fetch("https://api.individual.githubcopilot.com/chat/completions", {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "first" }] }),
    })
    await fetch("https://api.individual.githubcopilot.com/chat/completions", {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "second" }] }),
    })
  } finally {
    globalThis.fetch = original
  }

  const sessionCalls = calls.filter((c) => c.url.endsWith("/models/session"))
  expect(sessionCalls.length).toBe(1)
})

test("throws when session creation fails", async () => {
  const original = globalThis.fetch
  const mock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    await request.text()
    if (request.url.endsWith("/models/session")) return new Response("Forbidden", { status: 403 })
    return Response.json({})
  }

  globalThis.fetch = Object.assign(mock, original)
  const marker = Symbol.for("opeoginni.opencode-copilot-auto.fetch-adapter")
  delete (globalThis as typeof globalThis & { [marker]?: true })[marker]
  await CopilotAutoPlugin({} as never)

  let error: Error | undefined
  try {
    await fetch("https://api.individual.githubcopilot.com/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-error-token", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "Hi" }] }),
    })
  } catch (e) {
    error = e as Error
  } finally {
    globalThis.fetch = original
  }

  expect(error).toBeDefined()
  expect(error!.message).toContain("could not create a routing session")
})

test("throws when model selection fails", async () => {
  const original = globalThis.fetch
  const mock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    await request.text()
    if (request.url.endsWith("/models/session")) {
      return Response.json({
        available_models: ["gpt-5.4-mini"],
        selected_model: "gpt-5.4-mini",
        session_token: "session-token",
        expires_at: Math.floor(Date.now() / 1000) + 60,
      })
    }
    if (request.url.endsWith("/models/session/intent")) return new Response("error", { status: 500 })
    return Response.json({})
  }

  globalThis.fetch = Object.assign(mock, original)
  const marker = Symbol.for("opeoginni.opencode-copilot-auto.fetch-adapter")
  delete (globalThis as typeof globalThis & { [marker]?: true })[marker]
  await CopilotAutoPlugin({} as never)

  let error: Error | undefined
  try {
    await fetch("https://api.individual.githubcopilot.com/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-route-error-token", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "Hi" }] }),
    })
  } catch (e) {
    error = e as Error
  } finally {
    globalThis.fetch = original
  }

  expect(error).toBeDefined()
  expect(error!.message).toContain("could not select a model")
})

test("preserves models supplied by the built-in Copilot plugin", async () => {
  const plugin = await CopilotAutoPlugin({} as never)
  const existing = { "gpt-5.4-mini": { id: "gpt-5.4-mini" } } as never
  const models = await plugin.provider!.models!({ models: existing } as never, {})

  expect(models["gpt-5.4-mini"].id).toBe("gpt-5.4-mini")
  expect(models.auto.api.id).toBe("auto")
})
