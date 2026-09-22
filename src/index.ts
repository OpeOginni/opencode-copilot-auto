import { Plugin, type Model } from "@opencode/plugin"
import { autoModel, COPILOT_PACKAGE, isCopilotSDK, MODEL_ID, PROVIDER_ID } from "./auto.js"
import { Cache } from "./cache.js"
import { fingerprint, lastUserPrompt, type Prompt } from "./prompt.js"
import { Router, type Decision, type Fetch } from "./router.js"
import { CopilotAuto } from "./rpc.js"

const DEFAULT_BASE_URL = "https://api.githubcopilot.com"

export default Plugin.define({
  id: "opencode-copilot-auto",
  async setup(ctx) {
    const sticky = ctx.options.sticky === true
    const notifications = ctx.options.notifications === true
    // The TUI half of this package listens for `routed` and shows a toast.
    const rpc = notifications ? await ctx.rpc.register(CopilotAuto, {}) : undefined

    // Endpoint Copilot advertises per model, captured from the provider inventory.
    const endpoints = new Map<string, string>()
    // Last user prompt -> session, so the model wrapper can tell sessions apart.
    const sessions = new Cache<string, string>(500)
    // Routing decisions keyed by session (sticky) or by prompt.
    const models = new Cache<string, Promise<string>>(500)
    const routers = new Map<string, Router>()

    await ctx.provider.transform((editor) => {
      endpoints.clear()
      const record = editor.get(PROVIDER_ID)
      // The built-in Copilot plugin binds the inventory to a connection only
      // after a successful login, so this is the "user has authed" signal.
      if (!record?.sourceConnection) return

      let template: Model.Info | undefined
      for (const model of record.models.values()) {
        if (model.id === MODEL_ID) continue
        const endpoint = model.settings?.endpoint
        if (typeof endpoint === "string") endpoints.set(model.id, endpoint)
        if (!template && model.package === COPILOT_PACKAGE) template = model
      }
      if (!template) return

      const baseURL = template.settings?.baseURL
      editor.models.update(PROVIDER_ID, MODEL_ID, (model) => {
        model.name = "Auto"
        model.package = COPILOT_PACKAGE
        model.settings = { ...(typeof baseURL === "string" ? { baseURL } : {}), endpoint: "chat" }
        model.capabilities = { tools: true, input: ["text", "image"], output: ["text"] }
        model.limit = { context: 128_000, output: 16_384 }
        model.enabled = true
      })
    })

    const remember = (event: { sessionID: string; model: Model.Ref; messages: unknown }) => {
      if (event.model.id !== MODEL_ID) return
      sessions.set(fingerprint(lastUserPrompt(event.messages)), event.sessionID)
    }
    await ctx.session.hook("context", remember, { providerID: PROVIDER_ID })
    await ctx.session.hook("compaction", remember, { providerID: PROVIDER_ID })
    await ctx.session.hook("generate", remember, { providerID: PROVIDER_ID })
    await ctx.session.hook("title", remember, { providerID: PROVIDER_ID })

    const decide = async (router: Router, prompt: Prompt): Promise<Decision> => {
      const prompted = fingerprint(prompt)
      const sessionID = sessions.get(prompted)
      const key = sticky ? (sessionID ?? prompted) : prompted
      const pending =
        models.get(key) ??
        models.set(
          key,
          router
            .route(prompt)
            .then((model) => {
              // Fresh decision: once per session when sticky, once per prompt otherwise.
              // Fire-and-forget so the model request never waits on the UI.
              void rpc?.events.emit("routed", { model, ...(sessionID ? { sessionID } : {}) }).catch(() => {})
              return model
            })
            .catch((error: unknown) => {
              models.delete(key)
              throw error
            }),
        )
      return { model: await pending, token: await router.token() }
    }

    await ctx.aisdk.hook(
      "language",
      (event) => {
        if (event.model.providerID !== PROVIDER_ID || event.model.id !== MODEL_ID) return
        if (!isCopilotSDK(event.sdk)) {
          console.error(`[copilot-auto] unexpected Copilot SDK shape, leaving model untouched`)
          return
        }

        const baseURL = typeof event.options.baseURL === "string" ? event.options.baseURL : DEFAULT_BASE_URL
        const apiKey = typeof event.options.apiKey === "string" ? event.options.apiKey : ""
        const key = `${baseURL} ${apiKey}`
        const router = routers.get(key) ?? new Router(baseURL, fetcher(event.options))
        routers.set(key, router)

        event.language = autoModel({
          sdk: event.sdk,
          endpoints,
          decide: (prompt) => decide(router, prompt),
        })
      },
      { providerID: PROVIDER_ID },
    )
  },
})

/**
 * The built-in Copilot plugin installs an authenticated fetch on the model
 * options. Fall back to a bearer token when it is not there.
 */
function fetcher(options: Record<string, unknown>): Fetch {
  if (typeof options.fetch === "function") return options.fetch as Fetch
  const apiKey = typeof options.apiKey === "string" ? options.apiKey : undefined
  if (!apiKey) return fetch
  return (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set("Authorization", `Bearer ${apiKey}`)
    return fetch(input, { ...init, headers })
  }
}
