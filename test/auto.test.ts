import { expect, test } from "bun:test"
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { autoModel, endpointFor, isCopilotSDK, type CopilotSDK } from "../src/auto.js"

test("prefers the endpoint Copilot advertises, then the GPT-5 rule", () => {
  const endpoints = new Map([
    ["gpt-4.1", "responses"],
    ["gpt-5.4", "chat"],
    ["claude-sonnet-4.5", "messages"],
  ])
  expect(endpointFor("gpt-4.1", endpoints)).toBe("responses")
  expect(endpointFor("gpt-5.4", endpoints)).toBe("chat")
  expect(endpointFor("claude-sonnet-4.5", endpoints)).toBe("chat")
  expect(endpointFor("gpt-5.3-codex", new Map())).toBe("responses")
  expect(endpointFor("gpt-5-mini", new Map())).toBe("chat")
  expect(endpointFor("mai-code", new Map())).toBe("responses")
  expect(endpointFor("gpt-4o", new Map())).toBe("chat")
  expect(endpointFor("claude-haiku-4.5", new Map())).toBe("chat")
})

test("recognises the built-in Copilot SDK shape", () => {
  expect(isCopilotSDK({ chat() {}, responses() {} })).toBe(true)
  // The real SDK is a callable provider with the factories attached.
  const provider = Object.assign(() => {}, { languageModel() {}, chat() {}, responses() {} })
  expect(isCopilotSDK(provider)).toBe(true)
  expect(isCopilotSDK({ languageModel() {} })).toBe(false)
  expect(isCopilotSDK(undefined)).toBe(false)
})

function fakeSDK() {
  const created: Array<{ endpoint: string; model: string }> = []
  const received: LanguageModelV3CallOptions[] = []
  const make = (endpoint: string) => (model: string): LanguageModelV3 => {
    created.push({ endpoint, model })
    return {
      specificationVersion: "v3",
      provider: "github-copilot",
      modelId: model,
      supportedUrls: {},
      async doGenerate(options) {
        received.push(options)
        return { content: [], finishReason: { unified: "stop", raw: undefined }, usage: {} as never, warnings: [] }
      },
      async doStream(options) {
        received.push(options)
        return { stream: new ReadableStream() }
      },
    }
  }
  const sdk: CopilotSDK = { chat: make("chat"), responses: make("responses") }
  return { sdk, created, received }
}

const options: LanguageModelV3CallOptions = {
  prompt: [
    { role: "user", content: [{ type: "text", text: "earlier" }] },
    { role: "user", content: [{ type: "text", text: "Write tests" }] },
  ],
  headers: { "x-existing": "1" },
}

test("routes then streams through the Responses model for GPT-5", async () => {
  const fake = fakeSDK()
  const prompts: string[] = []
  const model = autoModel({
    sdk: fake.sdk,
    endpoints: new Map(),
    decide: async (prompt) => {
      prompts.push(prompt.text)
      return { model: "gpt-5.4", token: "session-token" }
    },
  })

  await model.doStream(options)

  expect(prompts).toEqual(["Write tests"])
  expect(fake.created).toEqual([{ endpoint: "responses", model: "gpt-5.4" }])
  expect(fake.received[0].headers).toEqual({ "x-existing": "1", "copilot-session-token": "session-token" })
  expect(fake.received[0].prompt).toBe(options.prompt)
})

test("routes then generates through the chat model for other models", async () => {
  const fake = fakeSDK()
  const model = autoModel({
    sdk: fake.sdk,
    endpoints: new Map(),
    decide: async () => ({ model: "claude-haiku-4.5", token: "t" }),
  })

  await model.doGenerate(options)

  expect(fake.created).toEqual([{ endpoint: "chat", model: "claude-haiku-4.5" }])
  expect(model.modelId).toBe("auto")
  expect(model.provider).toBe("github-copilot")
})
