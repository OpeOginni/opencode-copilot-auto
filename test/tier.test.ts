import { expect, test } from "bun:test"
import { tier, TIERS } from "../src/tier.js"

test("accepts the three public tiers and an unset preference", () => {
  for (const id of TIERS) expect(tier(id)).toBe(id)
  expect(tier(undefined)).toBeUndefined()
  expect(tier(null)).toBeUndefined()
})

test("rejects unsupported tier values", () => {
  for (const value of ["fast", "balanced", "Intelligence", "", true, 1]) {
    expect(() => tier(value)).toThrow("efficiency, balance, intelligence")
  }
})
