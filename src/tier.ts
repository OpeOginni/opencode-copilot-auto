export const TIERS = ["efficiency", "balance", "intelligence"] as const
export type Tier = (typeof TIERS)[number]

export function tier(value: unknown): Tier | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string" && TIERS.includes(value as Tier)) return value as Tier
  throw new Error(`Copilot Auto tier must be one of: ${TIERS.join(", ")}`)
}
