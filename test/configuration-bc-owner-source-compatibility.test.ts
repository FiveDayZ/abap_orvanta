import assert from "node:assert/strict"
import test from "node:test"
import { configurationBcOwnerInclude } from "../src/configuration-bc-owner-api.js"

test("ECC INSERT REPORT source lines stay within its 255-character limit", () => {
  const oversized = configurationBcOwnerInclude.source
    .map((line, index) => ({ line: index + 1, length: line.length }))
    .filter((entry) => entry.length > 255)
  assert.deepEqual(oversized, [])
})
