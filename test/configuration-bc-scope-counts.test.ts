import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  configurationBcStateKeyCount,
  configurationBcStateTableCount,
  configurationBcStateTables
} from "../src/configuration-bc-state-api.js"
import { configurationBcNativeSourcePins } from "../src/configuration-bc-native.js"
import { configurationBcGuardKeys } from "../src/configuration-bc-guard.js"
import { configurationBcGuardLayouts } from "../src/configuration-bc-guard-api.js"
import { SPRO_CORE_DELIVERY_PATH } from "../src/spro-core-delivery.js"

/**
 * The delivered prose states the pilot's size in words - "fixed nine-table/nineteen-key CUNI scope" -
 * and the before-state carries the same two numbers as fields. Those two numbers used to be literals in
 * the state module while the tables and layouts that decide them sat in the same file, so a tenth table
 * or a fourth language would have left the delivered count behind. The expectations below are counted
 * from the layouts, which is a different source from the derived values they check, so a change on either
 * side turns this red.
 */
const nativeTables = Object.keys(configurationBcNativeSourcePins)
const languageTables = ["T006A", "T006B", "T006C"]
const expectedTableCount = nativeTables.length + Object.keys(configurationBcGuardLayouts).length
const expectedKeyCount =
  nativeTables.reduce((total, name) => total + (languageTables.includes(name) ? 3 : 1), 0) +
  configurationBcGuardKeys.length

const contractText = readFileSync(SPRO_CORE_DELIVERY_PATH, "utf8")
// The shipped description text, read from the built module: the source .ts is not in the test tree.
const descriptionsText = readFileSync(
  fileURLToPath(new URL("../src/contracts.js", import.meta.url)),
  "utf8"
)

const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty"
]
const word = (value: number) => WORDS[value] ?? String(value)

test("the delivered scope counts are derived, and the layouts agree with them", () => {
  assert.equal(expectedTableCount, 9, "five native tables plus four guard layouts")
  assert.equal(expectedKeyCount, 19, "eleven native key rows plus eight guard fixed keys")
  assert.equal(configurationBcStateTableCount, expectedTableCount)
  assert.equal(configurationBcStateKeyCount, expectedKeyCount)
  // The member list the state module ships is the same nine tables, so the count cannot describe a
  // different set than the layouts it is derived from.
  assert.equal(configurationBcStateTables.length, expectedTableCount)
  assert.deepEqual(
    [...configurationBcStateTables].sort(),
    [...nativeTables, ...Object.keys(configurationBcGuardLayouts)].sort()
  )
})

test("every delivered spelling of the CUNI scope agrees with the derived counts", () => {
  // The delivery contract's scenario scope and the tool descriptions both spell the size in words.
  for (const [label, text] of [
    ["the delivery contract", contractText],
    ["the tool descriptions", descriptionsText]
  ] as const) {
    assert.match(
      text,
      new RegExp(`${word(expectedTableCount)}-table`),
      `${label} must state the derived table count`
    )
    assert.match(
      text,
      new RegExp(`${word(expectedKeyCount)}-key`),
      `${label} must state the derived key count`
    )
  }
  // The contract's scope sentence is the one a reader uses to size the pilot, so it must carry both.
  const scope = /"scope": "EHS_CUNI_KNM\/N only,([^"]*)"/.exec(contractText)
  assert.ok(scope, "the contract needs the bc-knm scope sentence")
  assert.match(scope[1]!, new RegExp(`${word(expectedTableCount)}-table`))
  assert.match(scope[1]!, new RegExp(`${word(expectedKeyCount)}-key`))
  // A number spelled differently for the same set is the defect this file exists to prevent.
  for (const stale of ["ten-table", "eight-table", "twenty-key", "eighteen-key"]) {
    assert.doesNotMatch(contractText, new RegExp(stale))
  }
})

test("the scope fields a caller receives carry the derived counts, not literals", () => {
  // Reading the built modules proves the shipped code computes them rather than embedding 9 and 19.
  const state = readFileSync(
    fileURLToPath(new URL("../src/configuration-bc-state.js", import.meta.url)),
    "utf8"
  )
  assert.match(state, /tableCount: configurationBcStateTableCount/)
  assert.match(state, /keyCount: configurationBcStateKeyCount/)
  assert.match(state, /tableCount: z\.literal\(configurationBcStateTableCount\)/)
  assert.match(state, /keyCount: z\.literal\(configurationBcStateKeyCount\)/)
  assert.doesNotMatch(state, /tableCount: 9|keyCount: 19|z\.literal\(9\)|z\.literal\(19\)/)

  // The preflight carries the finer breakdown a reader uses to size the change: eleven candidate keys
  // plus eight protection keys is the nineteen, and all four numbers now come from the one declaration.
  const preflight = readFileSync(
    fileURLToPath(new URL("../src/configuration-bc-preflight.js", import.meta.url)),
    "utf8"
  )
  assert.match(preflight, /tableCount: configurationBcStateTableCount/)
  assert.match(preflight, /candidateKeys: configurationBcStateCandidateKeyCount/)
  assert.match(preflight, /protectionKeys: configurationBcStateProtectionKeyCount/)
  assert.doesNotMatch(preflight, /tableCount: 9|candidateKeys: 11|protectionKeys: 8/)
})
