import type { Plugin } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk/v2"

const COPILOT_BASE_URL = "https://api.individual.githubcopilot.com"
const COPILOT_API_VERSION = "2026-06-01"
const SESSION_REFRESH_BUFFER_SECONDS = 30

type CopilotSession = {
  availableModels: string[]
  selectedModel: string
  token: string
  expiresAt: number
}

const sessions = new Map<string, CopilotSession>()

export const CopilotAutoPlugin: Plugin = async () => {
  installFetchAdapter()

  return {
    provider: {
      id: "github-copilot",
      models: async () => ({ auto: autoModel() }),
    },
  }
}

function autoModel(): Model {
  return {
    id: "auto",
    providerID: "github-copilot",
    name: "Auto",
    family: "gpt",
    api: {
      id: "auto",
      url: COPILOT_BASE_URL,
      npm: "@ai-sdk/github-copilot",
    },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, input: 128_000, output: 16_384 },
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

function installFetchAdapter() {
  const marker = Symbol.for("opeoginni.opencode-copilot-auto.fetch-adapter")
  const runtime = globalThis as typeof globalThis & { [marker]?: true }
  if (runtime[marker]) return
  runtime[marker] = true

  const originalFetch = globalThis.fetch.bind(globalThis)
  const adapter = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (!isAutoRequest(request)) return originalFetch(input, init)

    const body = await request.clone().text()
    const payload = parseJson(body)
    if (!payload || payload.model !== "auto") return originalFetch(input, init)

    const session = await getSession(originalFetch, request.headers)
    const model = await route(originalFetch, request.headers, session, payload)
    const headers = new Headers(request.headers)
    headers.set("copilot-session-token", session.token)

    return originalFetch(
      new Request(request, {
        headers,
        body: JSON.stringify({ ...payload, model }),
      }),
    )
  }
  globalThis.fetch = Object.assign(adapter, originalFetch)
}

function isAutoRequest(request: Request) {
  const url = new URL(request.url)
  return (
    url.origin === COPILOT_BASE_URL &&
    request.method === "POST" &&
    (url.pathname.endsWith("/chat/completions") || url.pathname.endsWith("/responses"))
  )
}

async function getSession(fetcher: typeof fetch, requestHeaders: Headers) {
  const key = requestHeaders.get("authorization") ?? "anonymous"
  const cached = sessions.get(key)
  if (cached && cached.expiresAt > Math.floor(Date.now() / 1000) + SESSION_REFRESH_BUFFER_SECONDS) return cached

  const response = await fetcher(`${COPILOT_BASE_URL}/models/session`, {
    method: "POST",
    headers: copilotHeaders(requestHeaders),
    body: JSON.stringify({ auto_mode: { model_hints: ["auto"] } }),
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`Copilot Auto could not create a routing session: ${response.status}`)

  const data = (await response.json()) as {
    available_models: string[]
    selected_model: string
    session_token: string
    expires_at: number
  }
  const session = {
    availableModels: data.available_models,
    selectedModel: data.selected_model,
    token: data.session_token,
    expiresAt: data.expires_at,
  }
  sessions.set(key, session)
  return session
}

async function route(fetcher: typeof fetch, requestHeaders: Headers, session: CopilotSession, payload: Record<string, unknown>) {
  const prompt = promptText(payload.messages)
  const headers = copilotHeaders(requestHeaders)
  headers.set("copilot-session-token", session.token)
  const response = await fetcher(`${COPILOT_BASE_URL}/models/session/intent`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt,
      available_models: session.availableModels,
      session_id: "opencode-session://auto",
      reference_count: 0,
      prompt_char_count: prompt.length,
      turn_number: userTurns(payload.messages),
      routing_method: "hydra",
      copilot_plan: "individual",
    }),
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`Copilot Auto could not select a model: ${response.status}`)

  const intent = (await response.json()) as { chosen_model?: string }
  return intent.chosen_model ?? session.selectedModel
}

function copilotHeaders(requestHeaders: Headers) {
  const headers = new Headers(requestHeaders)
  headers.set("Content-Type", "text/plain;charset=UTF-8")
  headers.set("X-GitHub-Api-Version", COPILOT_API_VERSION)
  return headers
}

function parseJson(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function promptText(messages: unknown) {
  if (!Array.isArray(messages)) return ""
  const message = [...messages].reverse().find((item) => isRecord(item) && item.role === "user")
  if (!message) return ""
  const content = message.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
}

function userTurns(messages: unknown) {
  return Array.isArray(messages) ? messages.filter((item) => isRecord(item) && item.role === "user").length : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export default CopilotAutoPlugin
