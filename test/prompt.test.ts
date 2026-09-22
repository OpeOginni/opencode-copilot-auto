import { expect, test } from "bun:test"
import { fingerprint, lastUserPrompt } from "../src/prompt.js"

test("reads the last user message from an AI SDK prompt", () => {
  const prompt = lastUserPrompt([
    { role: "system", content: "Be helpful." },
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "assistant", content: [{ type: "text", text: "reply" }] },
    { role: "user", content: [{ type: "text", text: "second" }, { type: "text", text: "line" }] },
    { role: "tool", content: [] },
  ])
  expect(prompt).toEqual({ text: "second\nline", image: false })
})

test("reads the last user message from OpenCode messages", () => {
  const prompt = lastUserPrompt([
    { role: "user", content: [{ type: "text", text: "hello" }, { type: "media", mediaType: "image/png", data: "" }] },
  ])
  expect(prompt).toEqual({ text: "hello", image: true })
})

test("detects AI SDK image parts", () => {
  const prompt = lastUserPrompt([
    { role: "user", content: [{ type: "text", text: "look" }, { type: "file", mediaType: "image/jpeg", data: "" }] },
  ])
  expect(prompt.image).toBe(true)
})

test("ignores non-image files and string content", () => {
  expect(lastUserPrompt([{ role: "user", content: [{ type: "file", mediaType: "application/pdf", data: "" }] }])).toEqual({
    text: "",
    image: false,
  })
  expect(lastUserPrompt([{ role: "user", content: "plain" }])).toEqual({ text: "plain", image: false })
  expect(lastUserPrompt(undefined)).toEqual({ text: "", image: false })
})

test("fingerprints identical prompts identically", () => {
  const a = fingerprint({ text: "same", image: false })
  const b = fingerprint({ text: "same", image: true })
  const c = fingerprint({ text: "other", image: false })
  expect(a).toBe(b)
  expect(a).not.toBe(c)
})
