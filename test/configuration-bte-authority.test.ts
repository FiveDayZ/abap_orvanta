import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import {
  configurationBteMetadataApi as api,
  configurationBteMetadataPins as pins
} from "../src/configuration-bte-metadata-api.js"

test("ECC display authority succeeds with initial GRANTED_ACTVT; adapter preserves native refusal contract", () => {
  const actual = JSON.parse(
    readFileSync(
      new URL("./fixtures/view-authority-display-w200-r75.json", import.meta.url),
      "utf8"
    )
  ) as { sourceFingerprint: string; source: string[] }
  assert.equal(actual.sourceFingerprint, pins.standard.VIEW_AUTHORITY_CHECK.source)
  const standard = actual.source.join("\n")
  assert.match(standard, /WHEN 'S'\.[^]*?activity = '03'\.[\s\n]*WHEN OTHERS\./)
  const assignments = standard.match(/granted_actvt = ld_chk_result\./g)!
  const guarded = standard.match(
    /ELSEIF ld_2nd_chk = lc_true\.[\s\n]*granted_actvt = ld_chk_result\./g
  )!
  assert.equal(assignments.length, guarded.length)
  assert.match(standard, /IF ld_chk_result = lc_failed\.[\s\n]*RAISE no_authority\./)
  const source = api.source.join("\n")
  assert.match(source, /CALL FUNCTION 'VIEW_AUTHORITY_CHECK'[^]*?view_action = 'S'/)
  assert.doesNotMatch(source, /lv_granted|granted_actvt|check_action_alternative/)
  assert.match(source, /lv_rc = sy-subrc\.[\s\n]*IF lv_rc <> 0\./)
  for (const [name, code] of [
    ["no_authority", 2],
    ["no_clientindependent_authority", 3],
    ["no_linedependent_authority", 5]
  ] as const)
    assert(source.includes(`${name} = ${code}`))
  assert.match(
    source,
    /IF lv_rc = 2 OR lv_rc = 3 OR lv_rc = 5\.[\s\n]*ev_code = 'AUTHORIZATION_DENIED'\./
  )
  assert.match(source, /REFRESH: et_header, et_namtab, et_events\./)
})
