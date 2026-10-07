import { isRecord, type Prompt } from "./prompt.js"
import type { Tier } from "./tier.js"

const API_VERSION = "2026-08-01"
const REFRESH_BUFFER_SECONDS = 30
const TIMEOUT_MS = 5_000

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type Decision = {
  model: string
  token: string
  expiresAt?: number
}

type TierMetadata = {
  tiers: Array<{ id: string; type: string; status: { enabled: boolean; message?: string } }>
}

type CopilotSession = {
  availableModels: string[]
  selectedModel: string
  token: string
  expiresAt: number
}

/**
 * Talks to Copilot's routing endpoints. The fetch passed in must already
 * carry Copilot authentication; OpenCode's built-in Copilot plugin provides
 * one on the model options.
 */
export class Router {
  private session?: CopilotSession
  private metadata?: Promise<TierMetadata | undefined>

  constructor(
    private readonly baseURL: string,
    private readonly call: Fetch,
  ) {}

  /** Current routing session token. Refreshed when close to expiry. */
  async token(): Promise<string> {
    return (await this.getSession()).token
  }

  /** Explicit tiers use Auto v2, which returns an inseparable model/token pair. */
  async select(prompt: Prompt, tier?: Tier): Promise<Decision> {
    if (!tier) return { model: await this.route(prompt), token: await this.token() }
    const metadata = await this.getMetadata()
    if (metadata) {
      const preference = metadata.tiers.find((item) => item.id === tier && item.type === "auto")
      if (!preference?.status.enabled) {
        throw new Error(`Copilot Auto tier '${tier}' is unavailable: ${preference?.status.message ?? "not enabled for this account"}`)
      }
    }
    const response = await this.call(`${this.baseURL}/auto`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        prompt: prompt.text,
        has_image: prompt.image,
        tier,
        multi_turn: { routing_intent: "anchor", turns_since_anchor: 0 },
        hydra_rl_multi_turn: {},
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`Copilot Auto could not select tier '${tier}': ${response.status}`)
    const data: unknown = await response.json()
    if (
      !isRecord(data) ||
      !isRecord(data.selected_model) ||
      typeof data.selected_model.id !== "string" ||
      !data.selected_model.id.trim() ||
      typeof data.session_token !== "string" ||
      !data.session_token.trim()
    ) {
      throw new Error("Copilot Auto returned an invalid model/token pair")
    }
    const expiresAt =
      typeof data.expires_at === "number" && Number.isFinite(data.expires_at)
        ? data.expires_at
        : tokenExpiry(data.session_token)
    if (expiresAt <= Math.floor(Date.now() / 1000)) throw new Error("Copilot Auto returned an expired session token")
    debug("auto", { model: data.selected_model.id, tier })
    return {
      model: data.selected_model.id,
      token: data.session_token,
      expiresAt,
    }
  }

  private async getMetadata(): Promise<TierMetadata | undefined> {
    this.metadata ??= this.loadMetadata().catch((error: unknown) => {
      this.metadata = undefined
      throw error
    })
    return this.metadata
  }

  private async loadMetadata(): Promise<TierMetadata | undefined> {
    const response = await this.call(`${this.baseURL}/meta`, {
      headers: headers(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    // Older Copilot deployments support the three standard tiers but do not
    // publish discovery metadata. Let /auto enforce availability there.
    if (response.status === 404 || response.status === 405) return undefined
    if (!response.ok) throw new Error(`Copilot Auto could not discover tiers: ${response.status}`)
    const data: unknown = await response.json()
    if (!isRecord(data)) throw new Error("Copilot Auto returned invalid tier metadata")
    if (data.auto === undefined) return { tiers: [] }
    if (!isRecord(data.auto) || !Array.isArray(data.auto.tiers)) {
      throw new Error("Copilot Auto returned invalid tier metadata")
    }
    const tiers = data.auto.tiers.filter(isRecord).flatMap((item) => {
      if (typeof item.id !== "string" || typeof item.type !== "string" || !isRecord(item.status)) return []
      return [{
        id: item.id,
        type: item.type,
        status: {
          enabled: item.status.enabled === true,
          ...(typeof item.status.message === "string" ? { message: item.status.message } : {}),
        },
      }]
    })
    return { tiers }
  }

  /** Ask Copilot which model should handle the prompt. */
  async route(prompt: Prompt): Promise<string> {
    const session = await this.getSession()
    const response = await this.call(`${this.baseURL}/models/session/intent`, {
      method: "POST",
      headers: headers({ "copilot-session-token": session.token }),
      body: JSON.stringify({
        prompt: prompt.text,
        available_models: session.availableModels,
        has_image: prompt.image,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`Copilot Auto could not select a model: ${response.status}`)
    const intent = (await response.json()) as { chosen_model?: string }
    debug("intent", intent)
    return intent.chosen_model ?? session.selectedModel
  }

  private async getSession(): Promise<CopilotSession> {
    const now = Math.floor(Date.now() / 1000)
    if (this.session && this.session.expiresAt > now + REFRESH_BUFFER_SECONDS) return this.session

    const response = await this.call(`${this.baseURL}/models/session`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ auto_mode: { model_hints: ["auto"] } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`Copilot Auto could not create a routing session: ${response.status}`)
    const data = (await response.json()) as {
      available_models: string[]
      selected_model: string
      session_token: string
      expires_at: number
    }
    debug("session", { ...data, session_token: "<redacted>" })
    this.session = {
      availableModels: data.available_models,
      selectedModel: data.selected_model,
      token: data.session_token,
      expiresAt: data.expires_at,
    }
    return this.session
  }
}

/** JWT expiry when available; opaque tokens are conservatively refreshed after five minutes. */
function tokenExpiry(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as { exp?: number }
    if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) return payload.exp
  } catch {}
  return Math.floor(Date.now() / 1000) + 300
}

// Set OPENCODE_COPILOT_AUTO_DEBUG=1 on the server to print Copilot's raw routing responses.
function debug(label: string, value: unknown) {
  if (!process.env.OPENCODE_COPILOT_AUTO_DEBUG) return
  console.error(`[copilot-auto] ${label} ${JSON.stringify(value)}`)
}

function headers(extra: Record<string, string> = {}) {
  return {
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": API_VERSION,
    ...extra,
  }
}
