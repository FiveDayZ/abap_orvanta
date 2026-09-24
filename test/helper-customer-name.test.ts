import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { repositoryRoot } from "../src/verification-registry.js"

const helperScript = readFileSync(
  join(repositoryRoot, "scripts", "bootstrap-sap-helper.ps1"),
  "utf8"
)

/** The shared DDIC write guard, from the customer verdict it computes to the rejection it drives. */
function sharedWriteGuard(): string {
  const marker = helperScript.indexOf("lv_customer_name = ''.")
  assert.ok(marker > 0, "the shared DDIC write guard must compute lv_customer_name")
  return helperScript.slice(marker, marker + 1200)
}

/**
 * The customer-name rule exists in two places: this server (`customerDdicName` and
 * `customerLockObjectName` in `src/tools.ts`) and the ABAP the helper is generated from.
 *
 * 0.47.16 relaxed only the server side, so the deployed helper kept answering
 * CUSTOMER_OBJECT_REQUIRED for EZPMCTPRP while the public tool description promised the E prefix was
 * accepted - the caller could not tell which layer refused, and the write receipt reported the
 * outcome as unknown (2026-09-24 21:22 incident). These assertions read the generator, which is the
 * single source of the deployed guard, so the two sides cannot drift apart again.
 */
test("the helper's shared DDIC write guard accepts E plus Z/Y for lock objects", () => {
  const guard = sharedWriteGuard()
  assert.match(guard, /iv_object_name\(1\) = 'Z' OR iv_object_name\(1\) = 'Y'/)
  assert.match(guard, /lv_object_type = 'ENQU' AND iv_object_name\(1\) = 'E'/)
  assert.match(guard, /iv_object_name\+1\(1\) = 'Z' OR iv_object_name\+1\(1\) = 'Y'/)
  assert.match(guard, /ev_code = 'CUSTOMER_OBJECT_REQUIRED'/)
})

test("the helper keeps the strict rule for every DDIC family that has no E convention", () => {
  // Number range objects, maintenance views and append structures have no SAP convention of an E
  // prefix. Relaxing them would make an EMARA-style name a writable customer object, which is the
  // protection the shared guard exists for in the first place.
  const strict = helperScript.match(/lv_(?:nrob|mv|ap)_name_raw\(1\)\s*<>\s*'Z'/g) ?? []
  assert.equal(
    strict.length,
    4,
    "the four per-family guards (number range read and write, maintenance view, append structure) must stay strict"
  )
  assert.match(helperScript, /Only Z or Y number range objects are writable/)
  assert.match(helperScript, /Only Z or Y maintenance views are writable/)
  assert.match(helperScript, /Only Z or Y append structures are writable/)
})
