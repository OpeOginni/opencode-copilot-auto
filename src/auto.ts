import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { lastUserPrompt, type Prompt } from "./prompt.js"
import type { Decision } from "./router.js"

export const PROVIDER_ID = "github-copilot"
export const MODEL_ID = "auto"
export const COPILOT_PACKAGE = "aisdk:@ai-sdk/github-copilot"

/** The SDK OpenCode's built-in Copilot plugin creates for `@ai-sdk/github-copilot` models. */
export type CopilotSDK = {
  chat: (modelID: string) => LanguageModelV3
  responses: (modelID: string) => LanguageModelV3
}

// AI SDK providers are callable functions with model factories attached as properties.
export function isCopilotSDK(sdk: unknown): sdk is CopilotSDK {
  return (
    (typeof sdk === "object" || typeof sdk === "function") &&
    sdk !== null &&
    typeof (sdk as CopilotSDK).chat === "function" &&
    typeof (sdk as CopilotSDK).responses === "function"
  )
}

/**
 * Mirrors the built-in Copilot plugin: use the endpoint Copilot advertises for
 * the model, otherwise GPT-5 and newer speak Responses. `/v1/messages` models
 * fall back to chat because the OpenAI-compatible SDK cannot speak it.
 */
export function endpointFor(model: string, endpoints: ReadonlyMap<string, string>): "chat" | "responses" {
  const known = endpoints.get(model)
  if (known === "responses") return "responses"
  if (known === "chat" || known === "messages") return "chat"
  const match = /^gpt-(\d+)/.exec(model)
  return match && Number(match[1]) >= 5 && !model.startsWith("gpt-5-mini") ? "responses" : "chat"
}

export type AutoModelInput = {
  sdk: CopilotSDK
  endpoints: ReadonlyMap<string, string>
  decide: (prompt: Prompt) => Promise<Decision>
}

/**
 * A language model that asks Copilot which model to use, then delegates the
 * call to that model's native protocol.
 */
export function autoModel(input: AutoModelInput): LanguageModelV3 {
  const resolve = async (options: LanguageModelV3CallOptions) => {
    const decision = await input.decide(lastUserPrompt(options.prompt))
    const endpoint = endpointFor(decision.model, input.endpoints)
    const model = endpoint === "responses" ? input.sdk.responses(decision.model) : input.sdk.chat(decision.model)
    return {
      model,
      options: {
        ...options,
        headers: { ...options.headers, "copilot-session-token": decision.token },
      },
    }
  }

  return {
    specificationVersion: "v3",
    provider: PROVIDER_ID,
    modelId: MODEL_ID,
    supportedUrls: {},
    async doGenerate(options) {
      const next = await resolve(options)
      return next.model.doGenerate(next.options)
    },
    async doStream(options) {
      const next = await resolve(options)
      return next.model.doStream(next.options)
    },
  }
}
