import type { Plugin } from "@opencode-ai/plugin"
import { MODEL_ID, PROVIDER_ID } from "./auto.js"
import { registerAuto } from "./sdk.js"
import { tier, TIERS } from "./tier.js"

const SDK_URL = new URL("./sdk.js", import.meta.url).href

// V1 can register models but cannot wrap a language model like V2 can. Only
// Auto uses our SDK module; authentication and all other models stay native.
export const CopilotAutoPlugin: Plugin = async ({ client }, options = {}) => {
  const defaultTier = tier(options.tier)
  let registration: ReturnType<typeof registerAuto> | undefined

  return {
    dispose: async () => registration?.dispose(),
    provider: {
      id: PROVIDER_ID,
      async models(provider, context) {
        registration?.dispose()
        registration = undefined
        const templates = Object.values(provider.models).filter((model) => model.id !== MODEL_ID)
        const template = templates.find((model) => model.api.npm === "@ai-sdk/github-copilot")
        if (!template) return provider.models

        const endpoints = new Map<string, string>()
        for (const model of templates) {
          if ("endpoint" in model.api && typeof model.api.endpoint === "string") {
            endpoints.set(model.api.id, model.api.endpoint)
          }
        }
        registration = registerAuto({
          sticky: options.sticky === true,
          tier: defaultTier,
          endpoints,
          // Changing accounts must not reuse the previous account's decisions.
          account: context.auth?.type === "oauth" ? context.auth.refresh : provider.key ?? "",
          notify: options.notifications === true ? (model) => {
            void client.tui.showToast({
              body: { title: "Copilot Auto", message: `Routed to ${model}`, variant: "info" },
            }).catch(() => {})
          } : undefined,
        })

        return {
          ...provider.models,
          auto: {
            ...template,
            id: MODEL_ID,
            name: "Auto",
            family: "auto",
            api: { id: MODEL_ID, url: template.api.url.replace(/\/v1\/?$/, ""), npm: SDK_URL },
            headers: { ...template.headers, "x-copilot-auto-instance": registration.id },
            options: {},
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            limit: { context: 128_000, output: 16_384 },
            capabilities: {
              ...template.capabilities,
              reasoning: false,
              attachment: true,
              toolcall: true,
              input: { text: true, image: true, audio: false, video: false, pdf: false },
              output: { text: true, image: false, audio: false, video: false, pdf: false },
            },
            variants: Object.fromEntries(TIERS.map((id) => [id, { autoTier: id }])),
          },
        }
      },
    },
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== PROVIDER_ID || input.model.id !== MODEL_ID) return
      output.headers["x-opencode-session-id"] = input.sessionID
    },
  }
}

export default CopilotAutoPlugin
