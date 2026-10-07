import { Plugin, type Model } from "@opencode/plugin"
import { autoModel, COPILOT_PACKAGE, isCopilotSDK, MODEL_ID, PROVIDER_ID } from "./auto.js"
import { Cache } from "./cache.js"
import { fingerprint, lastUserPrompt, type Prompt } from "./prompt.js"
import { Router, type Decision, type Fetch } from "./router.js"
import { CopilotAuto } from "./rpc.js"
import { tier, TIERS, type Tier } from "./tier.js"

const DEFAULT_BASE_URL = "https://api.githubcopilot.com"

export default Plugin.define({
  id: "opencode-copilot-auto",
  async setup(ctx) {
    const sticky = ctx.options.sticky === true
    const notifications = ctx.options.notifications === true
    const defaultTier = tier(ctx.options.tier)
    // The TUI half of this package listens for `routed` and shows a toast.
    const rpc = notifications ? await ctx.rpc.register(CopilotAuto, {}) : undefined

    // Endpoint Copilot advertises per model, captured from the provider inventory.
    const endpoints = new Map<string, string>()
    // Last user prompt -> session, so the model wrapper can tell sessions apart.
    const sessions = new Cache<string, string>(500)
    // Routing decisions keyed by session (sticky) or by prompt.
    const models = new Cache<string, Promise<Decision>>(500)
    const preferences = new Cache<string, { tier?: Tier; revision: number }>(500)
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
        model.variants = TIERS.map((id) => ({ id: id as Model.VariantID, settings: { autoTier: id } }))
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

    const decide = async (
      router: Router,
      account: string,
      selectedTier: Tier | undefined,
      prompt: Prompt,
      requestSessionID?: string,
    ): Promise<Decision> => {
      const prompted = fingerprint(prompt)
      const sessionID = requestSessionID ?? sessions.get(prompted)
      const scope = JSON.stringify([account, sessionID ?? prompted])
      const previous = preferences.get(scope)
      const preference =
        previous && previous.tier === selectedTier
          ? previous
          : preferences.set(scope, { tier: selectedTier, revision: (previous?.revision ?? 0) + 1 })
      const key = JSON.stringify([scope, selectedTier, preference.revision, sticky ? "sticky" : prompted, prompt.image])
      let pending = models.get(key)
      if (pending) {
        const decision = await pending
        if (decision.expiresAt !== undefined && decision.expiresAt <= Math.floor(Date.now() / 1000) + 30) {
          // Another concurrent caller may already have replaced this expired pair.
          if (models.get(key) === pending) models.delete(key)
          pending = models.get(key)
        }
      }
      pending ??= models.set(
        key,
        router
          .select(prompt, selectedTier)
          .then((decision) => {
            // Fresh decision: also fires after a tier change or token expiry.
            // Fire-and-forget so the model request never waits on the UI.
            void rpc?.events.emit("routed", { model: decision.model, ...(sessionID ? { sessionID } : {}) }).catch(() => {})
            return decision
          })
          .catch((error: unknown) => {
            models.delete(key)
            throw error
          }),
      )
      const result = await pending
      return selectedTier ? result : { ...result, token: await router.token() }
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
        const selectedTier = tier(event.options.autoTier) ?? defaultTier

        event.language = autoModel({
          sdk: event.sdk,
          endpoints,
          decide: (prompt, sessionID) => decide(router, key, selectedTier, prompt, sessionID),
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
