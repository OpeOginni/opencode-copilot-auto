import type { Prompt } from "./prompt.js"

const API_VERSION = "2026-08-01"
const REFRESH_BUFFER_SECONDS = 30
const TIMEOUT_MS = 5_000

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type Decision = {
  model: string
  token: string
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

  constructor(
    private readonly baseURL: string,
    private readonly call: Fetch,
  ) {}

  /** Current routing session token. Refreshed when close to expiry. */
  async token(): Promise<string> {
    return (await this.getSession()).token
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
