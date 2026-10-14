import assert from "node:assert/strict"
import test from "node:test"
import {
  configurationBteContextProofApi as api,
  inspectConfigurationBteContextProof as inspect
} from "../src/configuration-bte-context-proof.js"

const a = "a".repeat(64),
  b = "b".repeat(64)
function fresh(marker: string) {
  return {
    EV_CODE: "CONTEXT_NEW",
    EV_SYSTEM: "GR2",
    EV_CLIENT: "200",
    EV_USER: "WYS",
    EV_REQUEST: marker,
    EV_PREVIOUS: "",
    EV_COUNT: "1"
  }
}
test("memory probe fits CHAR72 and invokes no native API, SQL, lock, GUI or commit", () => {
  for (const line of api.source) assert.ok(line.length <= 72)
  const code = api.source.filter((l) => !l.startsWith("*")).join("\n")
  assert.doesNotMatch(code, /\b(?:SELECT|INSERT|UPDATE|DELETE|MODIFY|COMMIT|ROLLBACK)\b/i)
  assert.doesNotMatch(code, /CALL FUNCTION|CALL TRANSACTION|CALL SCREEN|PERFORM|ENQUEUE|DEQUEUE/i)
  assert.match(code, /STATICS: lv_previous TYPE string, lv_count TYPE i/)
  assert.match(code, /IF lv_count >= 2/)
})
test("two fresh synthetic contexts do not imply native transaction or cleanup acceptance", () => {
  const value = inspect([a, b], [fresh(a), fresh(b)])
  assert.equal(value.freshNativeContextObserved, true)
  assert.equal(value.transactionVerified, false)
  assert.equal(value.sessionCleanupVerified, false)
  assert.equal(value.writeAvailable, false)
})
test("a reused context is a negative observation, never a reason to replay SAVE", () => {
  const value = inspect(
    [a, b],
    [fresh(a), { ...fresh(b), EV_CODE: "CONTEXT_REUSED", EV_PREVIOUS: a, EV_COUNT: "2" }]
  )
  assert.equal(value.freshNativeContextObserved, false)
  assert.equal(value.automaticRetry, false)
})
for (const patch of [
  { EV_CLIENT: "300" },
  { EV_USER: "OTHER" },
  { EV_SYSTEM: "GR3" },
  { EV_REQUEST: a },
  { EV_COUNT: "2" },
  { EV_PREVIOUS: a },
  { EV_CODE: "REPEATED_MARKER" },
  { EV_EXTRA: "unreviewed" }
])
  test(`mismatched/unverified context data is rejected: ${JSON.stringify(patch)}`, () => {
    assert.throws(() => inspect([a, b], [fresh(a), { ...fresh(b), ...patch }]))
  })
test("one call or a duplicated marker cannot establish context separation", () => {
  assert.throws(() => inspect([a], [fresh(a)]))
  assert.throws(() => inspect([a, a], [fresh(a), fresh(a)]))
})
