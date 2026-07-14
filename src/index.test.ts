import { expect, test } from "bun:test"
import { CopilotAutoPlugin } from "./index"

test("routes an auto chat request and forwards the Copilot session token", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = []
  const original = globalThis.fetch
  const mock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const body = JSON.parse((await request.text()) || "{}") as Record<string, unknown>
    calls.push({ url: request.url, body, headers: request.headers })

    if (request.url.endsWith("/models/session")) {
      return Response.json({
        available_models: ["gpt-5.4", "claude-sonnet-4"],
        selected_model: "gpt-5.4",
        session_token: "session-token",
        expires_at: Math.floor(Date.now() / 1000) + 60,
      })
    }
    if (request.url.endsWith("/models/session/intent")) return Response.json({ chosen_model: "claude-sonnet-4" })
    return Response.json({ choices: [] })
  }

  globalThis.fetch = Object.assign(mock, original)
  await CopilotAutoPlugin({} as never)

  try {
    await fetch("https://api.individual.githubcopilot.com/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "Fix this bug" }] }),
    })
  } finally {
    globalThis.fetch = original
  }

  expect(calls).toHaveLength(3)
  expect(calls[1].body).toMatchObject({
    prompt: "Fix this bug",
    available_models: ["gpt-5.4", "claude-sonnet-4"],
    turn_number: 1,
  })
  expect(calls[2].body.model).toBe("claude-sonnet-4")
  expect(calls[2].headers.get("copilot-session-token")).toBe("session-token")
})
