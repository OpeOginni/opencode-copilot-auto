import { expect, test } from "bun:test"
import { Router } from "../src/router.js"

type Call = { url: string; body: Record<string, unknown>; headers: Headers }

function copilot(input: { chosen?: string; expiresIn?: number; sessionStatus?: number; intentStatus?: number } = {}) {
  const calls: Call[] = []
  const call = async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = request instanceof URL ? request.href : typeof request === "string" ? request : request.url
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")), headers: new Headers(init?.headers) })
    if (url.endsWith("/models/session")) {
      if (input.sessionStatus) return new Response("nope", { status: input.sessionStatus })
      return Response.json({
        available_models: ["gpt-5.4-mini", "claude-haiku-4.5"],
        selected_model: "gpt-5.4-mini",
        session_token: `token-${calls.length}`,
        expires_at: Math.floor(Date.now() / 1000) + (input.expiresIn ?? 600),
      })
    }
    if (url.endsWith("/models/session/intent")) {
      if (input.intentStatus) return new Response("nope", { status: input.intentStatus })
      return Response.json(input.chosen ? { chosen_model: input.chosen } : {})
    }
    return new Response("unexpected", { status: 500 })
  }
  return { calls, call }
}

test("creates a routing session then asks for intent", async () => {
  const api = copilot({ chosen: "claude-haiku-4.5" })
  const router = new Router("https://api.individual.githubcopilot.com", api.call)

  const model = await router.route({ text: "Fix this bug", image: true })

  expect(model).toBe("claude-haiku-4.5")
  expect(api.calls.map((c) => c.url)).toEqual([
    "https://api.individual.githubcopilot.com/models/session",
    "https://api.individual.githubcopilot.com/models/session/intent",
  ])
  expect(api.calls[0].body).toEqual({ auto_mode: { model_hints: ["auto"] } })
  expect(api.calls[1].body).toEqual({
    prompt: "Fix this bug",
    available_models: ["gpt-5.4-mini", "claude-haiku-4.5"],
    has_image: true,
  })
  expect(api.calls[1].headers.get("copilot-session-token")).toBe("token-1")
  expect(api.calls[1].headers.get("X-GitHub-Api-Version")).toBe("2026-08-01")
})

test("reuses the session across routes and exposes its token", async () => {
  const api = copilot({ chosen: "gpt-5.4-mini" })
  const router = new Router("https://api.githubcopilot.com", api.call)

  await router.route({ text: "one", image: false })
  await router.route({ text: "two", image: false })
  const token = await router.token()

  expect(api.calls.filter((c) => c.url.endsWith("/models/session")).length).toBe(1)
  expect(token).toBe("token-1")
})

test("refreshes a session that is about to expire", async () => {
  const api = copilot({ chosen: "gpt-5.4-mini", expiresIn: 5 })
  const router = new Router("https://api.githubcopilot.com", api.call)

  await router.route({ text: "one", image: false })
  await router.route({ text: "two", image: false })

  expect(api.calls.filter((c) => c.url.endsWith("/models/session")).length).toBe(2)
})

test("falls back to the session's selected model without an intent", async () => {
  const api = copilot()
  const router = new Router("https://api.githubcopilot.com", api.call)
  expect(await router.route({ text: "hi", image: false })).toBe("gpt-5.4-mini")
})

test("surfaces session and intent failures", async () => {
  const failedSession = new Router("https://api.githubcopilot.com", copilot({ sessionStatus: 403 }).call)
  expect(failedSession.route({ text: "hi", image: false })).rejects.toThrow("could not create a routing session: 403")

  const failedIntent = new Router("https://api.githubcopilot.com", copilot({ intentStatus: 500 }).call)
  expect(failedIntent.route({ text: "hi", image: false })).rejects.toThrow("could not select a model: 500")
})
