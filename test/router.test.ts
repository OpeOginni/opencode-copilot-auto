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

function tierAPI(input: { metadataStatus?: number; autoStatus?: number; metadata?: unknown; response?: unknown } = {}) {
  const calls: Call[] = []
  const call = async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = request instanceof URL ? request.href : typeof request === "string" ? request : request.url
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")), headers: new Headers(init?.headers) })
    if (url.endsWith("/meta")) {
      if (input.metadataStatus) return new Response("metadata failed", { status: input.metadataStatus })
      return Response.json(input.metadata ?? { auto: { tiers: ["efficiency", "balance", "intelligence"].map((id) => ({
        id, type: "auto", status: { enabled: true },
      })) } })
    }
    if (url.endsWith("/auto")) {
      if (input.autoStatus) return new Response("auto failed", { status: input.autoStatus })
      return Response.json(input.response ?? {
        selected_model: { id: calls.length === 2 ? "gpt-5.4" : "claude-sonnet-4.5" },
        session_token: `auto-token-${calls.length}`,
      })
    }
    return new Response("unexpected", { status: 500 })
  }
  return { calls, call }
}

test("explicit tiers use Auto v2 and keep each selected model with its matching token", async () => {
  const api = tierAPI()
  const router = new Router("https://api.githubcopilot.com", api.call)
  const first = await router.select({ text: "Review this", image: true }, "intelligence")
  const second = await router.select({ text: "Next task", image: false }, "efficiency")
  expect(first).toMatchObject({ model: "gpt-5.4", token: "auto-token-2" })
  expect(second).toMatchObject({ model: "claude-sonnet-4.5", token: "auto-token-3" })
  expect(api.calls.map((call) => call.url)).toEqual([
    "https://api.githubcopilot.com/meta", "https://api.githubcopilot.com/auto", "https://api.githubcopilot.com/auto",
  ])
  expect(api.calls[1].body).toEqual({
    prompt: "Review this", has_image: true, tier: "intelligence",
    multi_turn: { routing_intent: "anchor", turns_since_anchor: 0 }, hydra_rl_multi_turn: {},
  })
  expect(api.calls[1].headers.get("X-GitHub-Api-Version")).toBe("2026-08-01")
})

test("unselected Auto keeps the existing routing flow", async () => {
  const api = copilot({ chosen: "claude-haiku-4.5" })
  const router = new Router("https://api.githubcopilot.com", api.call)
  expect(await router.select({ text: "hi", image: false })).toEqual({ model: "claude-haiku-4.5", token: "token-1" })
  expect(api.calls).toHaveLength(2)
})

test("rejects unavailable tiers using the account's metadata", async () => {
  for (const preference of [
    { id: "intelligence", type: "auto", status: { enabled: false, message: "Contact admin" } },
    { id: "intelligence", type: "ensemble", status: { enabled: true } },
  ]) {
    const api = tierAPI({ metadata: { auto: { tiers: [preference] } } })
    const router = new Router("https://api.githubcopilot.com", api.call)
    await expect(router.select({ text: "hi", image: false }, "intelligence")).rejects.toThrow("unavailable")
    expect(api.calls).toHaveLength(1)
  }
  const api = tierAPI({ metadata: { models: [] } })
  await expect(new Router("https://api.githubcopilot.com", api.call).select({ text: "hi", image: false }, "balance"))
    .rejects.toThrow("not enabled for this account")
})

test("older deployments without /meta still receive the requested tier, never a default substitute", async () => {
  const api = tierAPI({ metadataStatus: 404 })
  const router = new Router("https://api.githubcopilot.com", api.call)
  await router.select({ text: "hi", image: false }, "balance")
  expect(api.calls[1].body.tier).toBe("balance")
})

test("metadata failures can be retried and Auto v2 errors never fall back to legacy routing", async () => {
  const api = tierAPI({ metadataStatus: 403 })
  const router = new Router("https://api.githubcopilot.com", api.call)
  for (let i = 0; i < 2; i++) {
    await expect(router.select({ text: "hi", image: false }, "balance")).rejects.toThrow("discover tiers: 403")
  }
  expect(api.calls).toHaveLength(2)
  const failed = tierAPI({ autoStatus: 500 })
  await expect(new Router("https://api.githubcopilot.com", failed.call).select({ text: "hi", image: false }, "balance"))
    .rejects.toThrow("select tier 'balance': 500")
  expect(failed.calls).toHaveLength(2)
})

test("rejects invalid model/token pairs", async () => {
  for (const response of [[], {}, { selected_model: "gpt-5.4", session_token: "token" },
    { selected_model: { id: "" }, session_token: "token" }, { selected_model: { id: "gpt-5.4" }, session_token: "" }]) {
    const api = tierAPI({ response })
    await expect(new Router("https://api.githubcopilot.com", api.call).select({ text: "hi", image: false }, "balance"))
      .rejects.toThrow("invalid model/token pair")
  }
})

test("malformed tier discovery fails clearly", async () => {
  for (const metadata of [[], { auto: { tiers: "not an array" } }]) {
    const api = tierAPI({ metadata })
    await expect(new Router("https://api.githubcopilot.com", api.call).select({ text: "hi", image: false }, "balance"))
      .rejects.toThrow("invalid tier metadata")
    expect(api.calls).toHaveLength(1)
  }
})

test("uses returned or JWT token expiry and rejects already expired tokens", async () => {
  const exp = Math.floor(Date.now() / 1000) + 600
  const jwt = `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`
  for (const response of [
    { selected_model: { id: "gpt-5.4" }, session_token: jwt },
    { selected_model: { id: "gpt-5.4" }, session_token: "opaque", expires_at: exp },
  ]) {
    const api = tierAPI({ response })
    const decision = await new Router("https://api.githubcopilot.com", api.call).select({ text: "hi", image: false }, "balance")
    expect(decision.expiresAt).toBe(exp)
  }
  const api = tierAPI({ response: { selected_model: { id: "gpt-5.4" }, session_token: "token", expires_at: 1 } })
  await expect(new Router("https://api.githubcopilot.com", api.call).select({ text: "hi", image: false }, "balance"))
    .rejects.toThrow("expired session token")
})
