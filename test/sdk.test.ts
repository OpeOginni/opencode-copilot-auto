import { expect, test } from "bun:test"
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { createCopilotAuto, registerAuto } from "../src/sdk.js"

const prompt: LanguageModelV3CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "hello" }] }]

async function withModel(chosen: string, response: () => Response, run: (model: LanguageModelV3, requests: Array<{ url: string; body: any; headers: Headers }>) => Promise<void>) {
  const registration = registerAuto({ sticky: false, account: "test", endpoints: new Map() })
  const requests: Array<{ url: string; body: any; headers: Headers }> = []
  const sdk = createCopilotAuto({
    baseURL: "https://copilot-api.example.test",
    apiKey: "fake-key",
    headers: { "x-copilot-auto-instance": registration.id, "x-custom": "value" },
    fetch: async (input, init) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body ?? "{}"))
      requests.push({ url, body, headers: new Headers(init?.headers) })
      if (url.endsWith("/meta")) return new Response("", { status: 404 })
      if (url.endsWith("/auto")) return Response.json({ selected_model: { id: chosen }, session_token: "routing-token" })
      return response()
    },
  })
  try { await run(sdk.languageModel("auto"), requests) } finally { registration.dispose() }
}

function sse(items: unknown[]) {
  return new Response(items.map((item) => `data: ${typeof item === "string" ? item : JSON.stringify(item)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })
}

const options: LanguageModelV3CallOptions = { prompt, providerOptions: { "github-copilot": { autoTier: "balance" } } }

test("native Chat preserves Copilot reasoning, opaque metadata, tool calls and usage", async () => {
  await withModel("claude-sonnet-4.5", () => Response.json({
    id: "chat_1", object: "chat.completion", created: 1, model: "claude-sonnet-4.5",
    choices: [{ index: 0, message: { role: "assistant", content: null, reasoning_text: "Thinking", reasoning_opaque: "opaque",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }],
    }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  }), async (model, requests) => {
    const result = await model.doGenerate(options)
    expect(result.content).toContainEqual({ type: "reasoning", text: "Thinking", providerMetadata: { copilot: { reasoningOpaque: "opaque" } } })
    expect(result.content).toContainEqual({ type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: "{}",
      providerMetadata: { copilot: { reasoningOpaque: "opaque" } } })
    expect(result.usage.inputTokens.total).toBe(3)
    expect(result.finishReason.unified).toBe("tool-calls")
    expect(requests.at(-1)!.body.autoTier).toBeUndefined()
    expect(requests.at(-1)!.headers.get("authorization")).toBe("Bearer fake-key")
    expect(requests.at(-1)!.headers.get("x-custom")).toBe("value")
  })
})

test("native Chat streams reasoning and tools without injecting banner text", async () => {
  const chunk = (delta: unknown, finish_reason: string | null = null) => ({
    id: "chat_1", created: 1, model: "claude-sonnet-4.5", choices: [{ index: 0, delta, finish_reason }],
  })
  await withModel("claude-sonnet-4.5", () => sse([
    chunk({ reasoning_text: "Think", reasoning_opaque: "opaque" }),
    chunk({ content: "Answer" }),
    chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: "}" } }] }),
    { ...chunk({}, "tool_calls"), usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    "[DONE]",
  ]), async (model) => {
    const result = await model.doStream(options)
    const parts = await Array.fromAsync(result.stream)
    expect(parts).toContainEqual(expect.objectContaining({ type: "reasoning-delta", delta: "Think" }))
    expect(parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual(["Answer"])
    expect(parts).toContainEqual(expect.objectContaining({ type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: "{}" }))
    expect(parts).toContainEqual(expect.objectContaining({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" } }))
  })
})

test("native Responses preserves tools, encrypted reasoning metadata, and stateless continuations", async () => {
  await withModel("gpt-5.4", () => Response.json({
    id: "resp_1", created_at: 1, model: "gpt-5.4", status: "completed",
    output: [
      { type: "reasoning", id: "rs_1", encrypted_content: "encrypted", summary: [{ type: "summary_text", text: "Thinking" }] },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{}", status: "completed" },
    ], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  }), async (model, requests) => {
    const result = await model.doGenerate({ ...options, maxOutputTokens: 1000 })
    expect(result.content).toContainEqual(expect.objectContaining({ type: "reasoning", text: "Thinking",
      providerMetadata: { copilot: { itemId: "rs_1", reasoningEncryptedContent: "encrypted" } } }))
    expect(result.content).toContainEqual(expect.objectContaining({ type: "tool-call", toolCallId: "call_1", toolName: "lookup" }))
    await model.doGenerate({ ...options, prompt: [
      ...prompt,
      { role: "assistant", content: result.content.filter((part) => part.type === "reasoning" || part.type === "tool-call").map((part) => ({
        ...part,
        providerOptions: part.providerMetadata,
        ...(part.type === "tool-call" ? { input: JSON.parse(part.input) } : {}),
      })) },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call_1", toolName: "lookup", output: { type: "text", value: "Found" } }] },
    ] })
    const body = requests.at(-1)!.body
    expect(body.input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_1", output: "Found" }))
    expect(body.input).toContainEqual(expect.objectContaining({ type: "reasoning", encrypted_content: "encrypted" }))
    expect(body.store).toBe(false)
    expect(body.max_output_tokens).toBeUndefined()
    expect(body.autoTier).toBeUndefined()
  })
})

test("images reach both the tier router and the selected native protocol", async () => {
  await withModel("gpt-5.4", () => Response.json({ id: "resp_1", created_at: 1, model: "gpt-5.4", output: [], status: "completed",
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }), async (model, requests) => {
    await model.doGenerate({ ...options, prompt: [{ role: "user", content: [
      { type: "text", text: "Describe" }, { type: "file", mediaType: "image/png", data: new URL("https://example.test/image.png") },
    ] }] })
    expect(requests.find((item) => item.url.endsWith("/auto"))!.body.has_image).toBe(true)
    expect(requests.at(-1)!.body.input[0].content).toContainEqual({ type: "input_image", image_url: "https://example.test/image.png" })
  })
})

test("native Responses streams text and function calls without chat/SSE conversion", async () => {
  await withModel("gpt-5.4", () => sse([
    { type: "response.created", response: { id: "resp_1", created_at: 1, model: "gpt-5.4" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
    { type: "response.output_text.delta", item_id: "msg_1", delta: "Answer" },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1" } },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: "{}" },
    { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{}", status: "completed" } },
    { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
  ]), async (model) => {
    const result = await model.doStream(options)
    const parts = await Array.fromAsync(result.stream)
    expect(parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual(["Answer"])
    expect(parts).toContainEqual(expect.objectContaining({ type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: "{}" }))
    expect(parts).toContainEqual(expect.objectContaining({ type: "finish", finishReason: { unified: "tool-calls", raw: undefined } }))
  })
})

test("native errors propagate without hiding status or rewriting the response", async () => {
  await withModel("gpt-5.4", () => Response.json({ error: { message: "Rate limited", type: "rate_limit_error" } }, { status: 429 }), async (model) => {
    await expect(model.doGenerate(options)).rejects.toMatchObject({ statusCode: 429 })
    await expect(model.doStream(options)).rejects.toMatchObject({ statusCode: 429 })
  })
})
