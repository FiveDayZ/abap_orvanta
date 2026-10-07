import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import { configurationBcOwnerInclude } from "../src/configuration-bc-owner-api.js"

const observed = JSON.parse(
  readFileSync(new URL("./fixtures/bc-route-w200-r71.json", import.meta.url), "utf8")
) as { source: string[] }
type Bindings = Record<string, unknown>

// Interpret only EXPORT field bindings. This model does not emulate SAP binary serialization.
function projection(statement: string, bindings: Bindings) {
  const result: Bindings = {}
  for (const match of statement.matchAll(/(\w+) = ('[^']*'|[\w-]+)/g)) {
    const expression = match[2]!
    assert.ok(expression.startsWith("'") || Object.hasOwn(bindings, expression), expression)
    result[match[1]!] = expression.startsWith("'") ? expression.slice(1, -1) : bindings[expression]
  }
  assert.deepEqual(Object.keys(result), [
    "namespace",
    "system",
    "client",
    "user",
    "source",
    "target",
    "headers",
    "members",
    "methods"
  ])
  return createHash("sha256").update(JSON.stringify(result)).digest("hex")
}
const nativeExport = observed.source
  .join("\n")
  .match(/EXPORT namespace = 'ORVANTA_CUNI_ROUTE_V1'[\s\S]*?TO DATA BUFFER lv_buffer\./)![0]
const owner = configurationBcOwnerInclude.source.join("\n")
const block = owner.slice(
  owner.indexOf("IMPORTING ev_code = lv_code ev_metadata_version = lv_metadata"),
  owner.indexOf("CALL FUNCTION 'Z_ORVANTA_CFG_BC_PREVIEW'")
)
const ownerExports = [
  ...block.matchAll(/EXPORT namespace = 'ORVANTA_CUNI_ROUTE_V1'[\s\S]*?TO DATA BUFFER lv_buffer\./g)
].map((m) => m[0])
assert.equal(ownerExports.length, 2)
const before: Bindings = {
  "sy-sysid": "GR2",
  "sy-mandt": "200",
  "sy-uname": "WYS",
  lv_source: "source-before",
  lv_target: "target-before",
  "a-target_version": "target-before",
  lt_headers: [{ objectname: "CUNI", objecttype: "T" }],
  lt_members: [{ tabname: "T006" }],
  lt_methods: []
}
function ownerBindings(current: Bindings): Bindings {
  return {
    ...current,
    lt_objh: current.lt_headers,
    lt_objs: current.lt_members,
    lt_objm: current.lt_methods
  }
}
function accepted(current: Bindings, reported = projection(nativeExport, current)) {
  const bindings = ownerBindings(current)
  return (
    projection(ownerExports[0]!, bindings) === reported &&
    projection(ownerExports[1]!, bindings) === projection(nativeExport, before)
  )
}

test("actual target-bound route changes after an approved save but rebased metadata stays valid", () => {
  const after = { ...before, lv_target: "target-after" }
  assert.notEqual(projection(nativeExport, after), projection(nativeExport, before))
  assert.equal(accepted(before), true)
  assert.equal(accepted(after), true)
})

test("route metadata drift still rejects recovery when only the target binding is rebased", () => {
  for (const change of [
    { lt_headers: [{ objectname: "CUNI", objecttype: "V" }] },
    { lt_members: [{ tabname: "UNAPPROVED" }] },
    { lt_methods: [{ method: "AFTER_IMPORT" }] },
    { lv_source: "changed-source" },
    { "sy-uname": "OTHER" },
    { "sy-mandt": "300" },
    { "sy-sysid": "OTHER" },
    { "a-target_version": "changed-before-target" }
  ])
    assert.equal(accepted({ ...before, lv_target: "target-after", ...change }), false)
})

test("a stale or malformed current route response fails before comparison to immutable before metadata", () => {
  const after = { ...before, lv_target: "target-after" }
  assert.equal(accepted(after, projection(nativeExport, before)), false)
  assert.equal(accepted(after, "invalid"), false)
})

test("generated owner enforces both native hashes before frame, history and configuration checks", () => {
  assert.match(block, /IF lv_hash <> lv_metadata\.[\s\S]*?r-code = 'SOURCE_CHANGED'/)
  assert.match(block, /IF lv_metadata <> a-metadata_version\.[\s\S]*?r-code = 'SOURCE_CHANGED'/)
  assert.match(block, /alg = 'SHA2' data = lv_buffer[\s\S]*?hashstring = lv_hash/)
  assert.match(block, /alg = 'SHA2' data = lv_buffer[\s\S]*?hashstring = lv_metadata/)
  assert.ok(owner.indexOf(block) < owner.indexOf("IMPORT namespace = f_namespace"))
  assert.match(owner, /lv_source <> a-source_version/)
  assert.match(owner, /current <> desired OR current_effect <> after_effect/)
})
