import { Cache } from "./cache.js"
import { fingerprint, type Prompt } from "./prompt.js"
import type { Decision, Router } from "./router.js"
import type { Tier } from "./tier.js"

/** Same routing policy as V2, independent of V1's model registration. */
export class Routing {
  private models = new Cache<string, Promise<Decision>>(500)
  private preferences = new Cache<string, { tier?: Tier; revision: number }>(500)

  constructor(private readonly sticky: boolean, private readonly notify?: (model: string) => void) {}

  async decide(
    router: Router,
    account: string,
    selectedTier: Tier | undefined,
    prompt: Prompt,
    sessionID?: string,
  ): Promise<Decision> {
    const prompted = fingerprint(prompt)
    const scope = JSON.stringify([account, sessionID ?? prompted])
    const previous = this.preferences.get(scope)
    const preference =
      previous && previous.tier === selectedTier
        ? previous
        : this.preferences.set(scope, { tier: selectedTier, revision: (previous?.revision ?? 0) + 1 })
    const key = JSON.stringify([scope, selectedTier, preference.revision, this.sticky ? "sticky" : prompted, prompt.image])
    let pending = this.models.get(key)
    if (pending) {
      const decision = await pending
      if (decision.expiresAt !== undefined && decision.expiresAt <= Math.floor(Date.now() / 1000) + 30) {
        if (this.models.get(key) === pending) this.models.delete(key)
        pending = this.models.get(key)
      }
    }
    pending ??= this.models.set(
      key,
      router.select(prompt, selectedTier)
        .then((decision) => {
          this.notify?.(decision.model)
          return decision
        })
        .catch((error: unknown) => {
          this.models.delete(key)
          throw error
        }),
    )
    const decision = await pending
    return selectedTier ? decision : { ...decision, token: await router.token() }
  }
}
