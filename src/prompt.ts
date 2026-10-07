import { createHash } from "node:crypto"

// Works for both OpenCode's internal messages (parts: text | media) and the
// AI SDK LanguageModelV3 prompt (parts: text | file). Only the fields shared
// by both shapes are read.
export type Prompt = {
  text: string
  image: boolean
}

export function lastUserPrompt(messages: unknown): Prompt {
  const message = lastUser(messages)
  if (!message) return { text: "", image: false }
  const content = message.content
  if (typeof content === "string") return { text: content, image: false }
  if (!Array.isArray(content)) return { text: "", image: false }
  const parts = content.filter(isRecord)
  return {
    text: parts
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n"),
    image: parts.some(
      (part) =>
        (part.type === "file" || part.type === "media" || part.type === "image") &&
        typeof part.mediaType === "string" &&
        part.mediaType.startsWith("image/"),
    ),
  }
}

export function fingerprint(prompt: Prompt): string {
  return createHash("sha1").update(prompt.text).digest("hex")
}

function lastUser(messages: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const message: unknown = messages[i]
    if (isRecord(message) && message.role === "user") return message
  }
  return undefined
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
