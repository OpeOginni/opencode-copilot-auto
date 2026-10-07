import { createOpenaiCompatible } from "@opencode/core/github-copilot/copilot-provider"
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { autoModel, MODEL_ID, PROVIDER_ID, type CopilotSDK } from "./auto.js"
import { Router, type Fetch } from "./router.js"
import { Routing } from "./routing.js"
import type { Tier } from "./tier.js"

type Settings = {
  sticky: boolean
  tier?: Tier
  account: string
  endpoints: ReadonlyMap<string, string>
  notify?: (model: string) => void
}

// A module-local bridge for V1's file:// SDK loader. No globals, no fetch
// interception. Each plugin instance owns its registration and cleans it up.
const registrations = new Map<string, Settings>()
export function registerAuto(settings: Settings) {
  const id = crypto.randomUUID()
  registrations.set(id, settings)
  return { id, dispose: () => { registrations.delete(id) } }
}

type SDKOptions = {
  baseURL?: string
  apiKey?: string
  headers?: Record<string, string>
  fetch?: Fetch
}

/** The only create* export, as required by V1's SDK loader. */
export function createCopilotAuto(options: SDKOptions = {}) {
  const headers = { ...options.headers }
  const settings = registrations.get(headers["x-copilot-auto-instance"] ?? "")
  if (!settings) throw new Error("Copilot Auto SDK is not registered; reload the V1 plugin")
  delete headers["x-copilot-auto-instance"]
  const baseURL = (options.baseURL ?? "https://api.githubcopilot.com").replace(/\/$/, "")
  const call: Fetch = (input, init) => (options.fetch ?? fetch)(input, {
    ...init,
    headers: {
      ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
      ...headers,
      ...Object.fromEntries(new Headers(init?.headers)),
    },
  })
  const router = new Router(baseURL, call)
  const routing = new Routing(settings.sticky, settings.notify)
  const account = JSON.stringify([baseURL, settings.account, options.apiKey ?? ""])
  // Bun augments typeof fetch with preconnect; AI SDK only invokes the function.
  const sdkFetch = call as typeof fetch
  const native = createOpenaiCompatible({ name: PROVIDER_ID, baseURL, headers, fetch: sdkFetch })

  const adapt = (model: LanguageModelV3): LanguageModelV3 => {
    const prepare = (input: LanguageModelV3CallOptions): LanguageModelV3CallOptions => {
      const { autoTier: _, ...providerOptions } = input.providerOptions?.[PROVIDER_ID] ?? {}
      return {
        ...input,
        headers: Object.fromEntries(
          Object.entries(input.headers ?? {}).filter(([name]) => name.toLowerCase() !== "x-copilot-auto-instance"),
        ),
        // Copilot GPT models reject token limits, and Responses is stateless.
        ...(model.modelId.startsWith("gpt-") ? { maxOutputTokens: undefined } : {}),
        providerOptions: {
          ...input.providerOptions,
          [PROVIDER_ID]: providerOptions,
          copilot: { ...providerOptions, ...input.providerOptions?.copilot, store: false },
        },
      }
    }
    return {
      specificationVersion: "v3",
      provider: model.provider,
      modelId: model.modelId,
      supportedUrls: model.supportedUrls,
      doGenerate: (input) => model.doGenerate(prepare(input)),
      doStream: (input) => model.doStream(prepare(input)),
    }
  }
  const sdk: CopilotSDK = {
    chat: (id) => adapt(native.chat(id)),
    responses: (id) => adapt(native.responses(id)),
  }
  const language = autoModel({
    sdk,
    endpoints: settings.endpoints,
    decide: (prompt, sessionID, selectedTier) => routing.decide(router, account, selectedTier ?? settings.tier, prompt, sessionID),
  })
  const get = (id: string) => {
    if (id !== MODEL_ID) throw new Error(`Copilot Auto SDK cannot load model '${id}'`)
    return language
  }
  // V1's built-in Copilot loader may call chat() or responses(); Auto resolves
  // the real protocol at request time regardless of which factory it calls.
  return { languageModel: get, chat: get, responses: get }
}
