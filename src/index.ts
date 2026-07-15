import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk/v2"

const COPILOT_BASE_URL = "https://api.individual.githubcopilot.com"
const COPILOT_API_VERSION = "2026-07-01"
const SESSION_REFRESH_BUFFER_SECONDS = 30
const HYDRA_ROUTING = false

type CopilotSession = {
  availableModels: string[]
  selectedModel: string
  token: string
  expiresAt: number
}

const sessions = new Map<string, CopilotSession>()

type ToastClient = {
  tui?: {
    showToast?: (payload: { body: { title: string; message: string; variant: string } }) => Promise<void>
  }
}

function hasToast(client: unknown): client is ToastClient {
  return (
    typeof client === "object" &&
    client !== null &&
    "tui" in client &&
    typeof (client as ToastClient).tui?.showToast === "function"
  )
}

async function notifyModelSelected(client: unknown, model: string): Promise<void> {
  if (!hasToast(client)) return
  await client.tui!.showToast!({
    body: { title: "Copilot Auto", message: `Routed to ${model}`, variant: "info" },
  }).catch(() => {})
}

export const CopilotAutoPlugin: Plugin = async (input) => {
  installFetchAdapter(input.client)

  return {
    provider: {
      id: "github-copilot",
      models: async (provider) => ({ ...provider.models, auto: autoModel() }),
    },
    config: async (input) => {
      input.command ??= {}
      input.command["copilot-refresh"] ??= {
        template: "/copilot-refresh",
        description: "Clear Copilot Auto routing cache so the next prompt re-selects a model",
      }
    },
    "command.execute.before": async (input, output) => {
      if (input.command !== "copilot-refresh") return
      sessions.clear()
      output.parts.length = 0
      output.parts.push({
        id: crypto.randomUUID(),
        sessionID: input.sessionID,
        messageID: crypto.randomUUID(),
        type: "text",
        text: "Copilot Auto routing cache cleared. The next prompt will select a fresh model.",
      })
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

function installFetchAdapter(client?: PluginInput["client"]) {
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
    await notifyModelSelected(client, model)
    const useResponses = usesResponses(model)
    const headers = new Headers(request.headers)
    headers.set("copilot-session-token", session.token)
    headers.set("X-GitHub-Api-Version", COPILOT_API_VERSION)

    const next = useResponses ? toResponsesRequest(payload, model) : { ...payload, model }
    const url = useResponses ? toResponsesUrl(request.url) : request.url
    const response = await originalFetch(
      new Request(url, {
        method: request.method,
        headers,
        body: JSON.stringify(next),
        signal: request.signal,
      }),
    )
    return useResponses ? wrapResponsesResponse(response) : response
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

function usesResponses(modelID: string) {
  const match = /^gpt-(\d+)/.exec(modelID)
  return Boolean(match && Number(match[1]) >= 5)
}

function toResponsesUrl(url: string) {
  return url.replace(/\/chat\/completions\/?$/, "/responses")
}

function toResponsesRequest(payload: Record<string, unknown>, model: string) {
  const messages = Array.isArray(payload.messages) ? payload.messages as unknown[] : []
  const instructions = messages
    .filter((m) => isRecord(m) && m.role === "system")
    .map((m) => (isRecord(m) && typeof m.content === "string" ? m.content : ""))
    .filter(Boolean)
    .join("\n")

  const input = messages
    .filter((m) => isRecord(m) && m.role !== "system")
    .flatMap((m) => {
      const msg = m as Record<string, unknown>
      const role = msg.role as string
      const content = msg.content

      if (role === "tool") {
        return [{
          type: "function_call_output",
          call_id: msg.tool_call_id as string,
          output: typeof content === "string" ? content : JSON.stringify(content),
        }]
      }

      if (role === "assistant" && Array.isArray(msg.tool_calls)) {
        const items: unknown[] = msg.tool_calls.map((tc) => {
          if (!isRecord(tc) || !isRecord(tc.function)) return null
          return {
            type: "function_call",
            call_id: tc.id as string,
            name: tc.function.name as string,
            arguments: tc.function.arguments as string,
          }
        }).filter((x) => x !== null)
        if (typeof content === "string" && content) {
          items.unshift({
            role: "assistant",
            content: [{ type: "output_text", text: content }],
          })
        }
        return items
      }

      const text = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
              .filter(Boolean)
              .join("\n")
          : ""

      return [{
        role,
        content: [{ type: role === "user" ? "input_text" : "output_text", text }],
      }]
    })

  return {
    model,
    input,
    stream: payload.stream === true,
    ...(instructions ? { instructions } : {}),
    ...(typeof payload.temperature === "number" ? { temperature: payload.temperature } : {}),
    ...(typeof payload.top_p === "number" ? { top_p: payload.top_p } : {}),
    ...(typeof payload.max_tokens === "number"
      ? { max_output_tokens: payload.max_tokens }
      : typeof payload.max_completion_tokens === "number"
        ? { max_output_tokens: payload.max_completion_tokens }
        : {}),
    ...(Array.isArray(payload.tools) ? { tools: payload.tools.map(unwrapFunction) } : {}),
    ...(payload.tool_choice !== undefined ? { tool_choice: unwrapFunction(payload.tool_choice) } : {}),
  }
}

function unwrapFunction(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.function)) return value
  const { function: fn, ...rest } = value
  return { ...fn, ...rest }
}

function wrapResponsesResponse(response: Response): Response {
  const chunkId = `chatcmpl-auto-${Date.now()}`
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()

  let buffer = ""
  let toolCallIndex = -1

  const transformed = new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = response.body?.getReader()
      if (!reader) {
        controller.close()
        return
      }
      // TypeScript cannot narrow reader inside closures, alias to satisfy the type checker
      const stream = reader

      function emitChunk(delta: Record<string, unknown>, finishReason?: string) {
        const chunk = {
          id: chunkId,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      }

      function processLine(line: string) {
        if (line.startsWith("event:")) return
        if (!line.startsWith("data:")) return
        const data = line.slice(5).trim()
        if (data === "[DONE]") return

        try {
          const event = JSON.parse(data)
          const type = event.type as string

          if (type === "response.output_text.delta") {
            emitChunk({ content: event.delta })
          } else if (type === "response.output_item.added" && event.item?.type === "function_call") {
            // ceiling: only function_call items, no file_search/code_interpreter/image_gen
            toolCallIndex++
            emitChunk({
              tool_calls: [{
                index: toolCallIndex,
                id: event.item.call_id,
                type: "function",
                function: { name: event.item.name, arguments: "" },
              }],
            })
          } else if (type === "response.function_call_arguments.delta") {
            emitChunk({
              tool_calls: [{
                index: toolCallIndex,
                function: { arguments: event.delta },
              }],
            })
          } else if (type === "response.completed") {
            emitChunk({}, "stop")
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          }
        } catch {
          // ceiling: malformed SSE lines dropped silently, log for debugging if needed
        }
      }

      function pump(): Promise<void> {
        return stream.read().then(({ done, value }) => {
          if (done) {
            if (buffer) {
              for (const line of buffer.split("\n")) processLine(line)
            }
            controller.close()
            return
          }
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""
          for (const line of lines) processLine(line)
          return pump()
        })
      }

      pump().catch(() => controller.close())
    },
  })

  return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers({
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    }),
  })
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

async function route(
  fetcher: typeof fetch,
  requestHeaders: Headers,
  session: CopilotSession,
  payload: Record<string, unknown>,
) {
  const messages = payload.messages ?? payload.input
  const prompt = promptText(messages)
  const headers = copilotHeaders(requestHeaders)
  headers.set("copilot-session-token", session.token)
  const response = await fetcher(`${COPILOT_BASE_URL}/models/session/intent`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt,
      available_models: session.availableModels,
      has_image: false, // ceiling: hardcoded, detect image parts in payload.messages if needed
      ...(HYDRA_ROUTING
        ? {
            session_id: "opencode-session://auto",
            reference_count: 0,
            prompt_char_count: prompt.length,
            turn_number: userTurns(messages),
            routing_method: "hydra",
            copilot_plan: "individual",
          }
        : {}),
    }),
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`Copilot Auto could not select a model: ${response.status}`)

  const intent = (await response.json()) as { chosen_model?: string }
  return intent.chosen_model ?? session.selectedModel
}

function copilotHeaders(requestHeaders: Headers) {
  const headers = new Headers(requestHeaders)
  headers.set("Content-Type", "application/json")
  headers.set("X-GitHub-Api-Version", COPILOT_API_VERSION)
  return headers
}

function parseJson(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
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
