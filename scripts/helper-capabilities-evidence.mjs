// Reusable CAPABILITIES deployment evidence (docs/helper-capabilities-protocol.md 3.3).
//
// This module holds the *offline* half of the deployment evidence: the generator calibration
// (protocol range, operation rows, the placeholder-restoring SOURCE|HASH digest) and the rules
// for reading one helper's attestation out of the service's own read-only capability report.
//
// It deliberately does NOT parse the raw `EV_RESULT` payload rows itself. The service already
// owns that parser (`decodeJsonHelperCapabilitiesReply` and `parseHelperCapabilitiesPayload` in
// src/adt-backend.ts) and `get_capability_report` returns its verdict as `helperAttestation`; a
// second parser here would drift from the service-side twin, so the service stays the single
// source of truth for what a helper said.
//
// Nothing here imports from dist/ or src/ (those are build products) and nothing here contacts
// SAP: the only SAP interaction is the read-only `get_capability_report` MCP call made by
// scripts/verify-helper-deployment.mjs.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  maintenanceDiagnosticOperations,
  maintenanceDiagnosticSource
} from "./maintenance-diagnostic-source.mjs"
import { operationalLogOperations, operationalLogReportSource } from "./operational-log-source.mjs"

const HASH_SLOTS = ["ORVANTAHASHSLOT1", "ORVANTAHASHSLOT2", "ORVANTAHASHSLOT3", "ORVANTAHASHSLOT4"]

export function compareProtocolVersions(left, right) {
  const [leftMajor = 0, leftMinor = 0] = String(left).split(".").map(Number)
  const [rightMajor = 0, rightMinor = 0] = String(right).split(".").map(Number)
  return leftMajor - rightMajor || leftMinor - rightMinor
}

const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex")

/**
 * The ABAP body of one LIVE function module source, byte for byte the slice the deploy scripts
 * compare and hash: the `DATA:` declarations through the last body statement, with nothing after
 * the final line. The interface heading and the `ENDFUNCTION.` wrapper stay outside.
 *
 * Only a live function module source may be passed here. The generator exports are body-only and
 * carry no `ENDFUNCTION.`, so they must use `bodyLinesHash` instead.
 */
export function functionModuleBody(source) {
  const lines = source.split("\n")
  const start = lines.findIndex((line) => /^DATA:/.test(line))
  assert.ok(start >= 0, "function module source carries no DATA declaration")
  const end = lines.findIndex((line, index) => index > start && /^ENDFUNCTION\./.test(line.trim()))
  assert.ok(end > start, "function module source carries no ENDFUNCTION.")
  const body = lines.slice(start, end)
  while (body.at(-1)?.trim() === "") body.pop()
  return body
}

/**
 * The SHA-256 of one body slice, the value the deploy scripts pin as the live body hash. Only a
 * LIVE function module source may be passed here.
 */
export function functionModuleBodyHash(source) {
  return bodyLinesHash(functionModuleBody(source))
}

/**
 * The SHA-256 of a body-only line array, joined with "\n" and never with a trailing newline.
 *
 * The generator exports (`maintenanceDiagnosticSource`, `operationalLogReportSource`) are already
 * body-only: they start at the `DATA:` declarations, end at the last body statement (`ENDTRY.`)
 * and carry no `ENDFUNCTION.` wrapper, so they must be hashed directly.
 *
 * @param {string[]} lines
 * @returns {string}
 */
export function bodyLinesHash(lines) {
  assert.ok(Array.isArray(lines) && lines.length > 0, "a non-empty body line array is required")
  return hash(lines.join("\n"))
}

/**
 * The four hex groups of a rendered `SOURCE|HASH` row, in slot order.
 *
 * @param {string[]} body
 * @returns {string[]}
 */
export function capabilityHashSlotGroups(body) {
  const text = body.join("\n")
  assert.equal(
    text.includes("'SOURCE|HASH|'"),
    true,
    "no SOURCE|HASH row found in the generated body"
  )
  const match = /'SOURCE\|HASH\|'\s+([\s\S]+?)INTO lv_capabilit/.exec(text)
  assert.ok(match, "no SOURCE|HASH row with four 16-character slots found in the body")
  const groups = [...String(match[1]).matchAll(/'([0-9a-f]{16})'/g)].map((group) =>
    String(group[1])
  )
  assert.equal(groups.length, 4, "SOURCE|HASH must carry exactly four 16-character slots")
  for (const [index, group] of groups.entries())
    assert.equal(
      text.split(group).length,
      2,
      `${HASH_SLOTS[index]} must appear exactly once in the generated body`
    )
  return groups
}

/**
 * The digest the generator injected into a rendered body. The four `ORVANTAHASHSLOT1..4`
 * placeholders make `SOURCE|HASH` self-referential: the generator hashes the finished body while
 * the placeholders are still in it, then writes that digest into the same four slots. Restoring
 * the placeholders and re-hashing therefore reproduces the injected digest exactly, and this is
 * the digest a deployed helper must report as `SOURCE|HASH`.
 *
 * The restored digest is deliberately NOT the SHA-256 of the rendered body: the two differ
 * because the injected digest is part of the rendered text. `bodyLinesHash` is the separate
 * value the deploy scripts pin as the live body hash.
 *
 * @param {string[]} body
 * @returns {string}
 */
export function capabilityBodyDigest(body) {
  const groups = capabilityHashSlotGroups(body)
  let text = body.join("\n")
  groups.forEach((group, index) => {
    const slot = HASH_SLOTS[index] ?? ""
    assert.equal(slot.length, 16, "placeholders must keep the injected hash length")
    text = text.replace(group, slot)
  })
  return hash(text)
}

/**
 * The literal payload rows a generator renders into its CAPABILITIES branch: `HELPER`,
 * `PROTOCOL|MIN`, `PROTOCOL|MAX`, the `OPERATION` rows, `SOURCE|PACKAGE` and `SOURCE|TRANSPORT`.
 * `SOURCE|HASH` is assembled from four CONCATENATE operands and is covered by
 * `capabilityBodyDigest` instead.
 *
 * This is the authority for the post-deployment comparison: a helper must report what its own
 * generator renders, which is not necessarily what the object's current TADIR assignment says
 * (see the provenance note on `helperCapabilityTargets`).
 *
 * @param {string[]} body
 * @returns {string[]}
 */
export function renderedCapabilityRows(body) {
  const rows = body
    .map((line) => /^\s*APPEND '([^']*)' TO lt_capability\.$/.exec(line)?.[1])
    .filter((value) => typeof value === "string")
  assert.ok(rows.length > 0, "no literal payload rows found in the generated body")
  return rows
}

/**
 * The single source of truth for the intended post-upgrade state of the two helpers whose
 * CAPABILITIES body is generated by a local module (not by scripts/bootstrap-sap-helper.ps1).
 * Protocol range and operation list are derived from the generators' exported tables; only the
 * recorded deployment provenance and the verified live/intended body hashes are pinned here.
 *
 * `transportRequest`/`transportTask` are the provenance the GENERATOR renders into
 * `SOURCE|TRANSPORT` (`GR2K923421`/`GR2K923422`), which is what the post-deployment comparison
 * uses. That is historical provenance: the CAPABILITIES upgrade itself runs under a new request
 * (`transportUpgradeRequest`), so the live TADIR assignment may legitimately differ from the
 * rendered row. The verifier records both facts and never treats them as the same fact.
 */
const range = (operations) => {
  const versions = operations.map((operation) => operation.since).sort(compareProtocolVersions)
  return { min: versions[0], max: versions.at(-1) }
}

const operationRow = (opcode, since, mode) => `OPERATION|${opcode}|${since}|${mode}`

export const helperCapabilityTargets = {
  maint: {
    target: "maint",
    helper: "Z_ORVANTA_MAINT_READ",
    functionGroup: "ZORVANTA_MAINT",
    packageName: "ZABAP",
    transportRequest: "GR2K923421",
    transportTask: "GR2K923422",
    transportUpgradeRequest: "GR2K923472",
    expectedProtocol: range(maintenanceDiagnosticOperations),
    expectedOperations: maintenanceDiagnosticOperations.map((operation) =>
      operationRow(operation.opcode, operation.since, operation.mode)
    ),
    deployedNowBodyHash: "f2a1580c9ab7560d882af51d6c9152933248c0d51026ac56024417d540b763be",
    intendedBodyHash: "fc576f586b8924590502b31cc31b22313f2ddad1fe8f2ab203bdb0affa44afce",
    generatorBody: maintenanceDiagnosticSource
  },
  ops: {
    target: "ops",
    helper: "Z_ORVANTA_OPS_READ",
    functionGroup: "ZORVANTA_LOG",
    packageName: "ZABAP",
    transportRequest: "GR2K923421",
    transportTask: "GR2K923422",
    transportUpgradeRequest: "GR2K923472",
    expectedProtocol: range(operationalLogOperations),
    expectedOperations: operationalLogOperations.map((operation) =>
      operationRow(operation.opcode, operation.since, operation.mode)
    ),
    deployedNowBodyHash: "6cd998bf1e80e61e5d3c20ea416997a3310cc20611919134fe779149b95210ea",
    intendedBodyHash: "52d5769180591b4db408357f3391f6b605c7156333bbfa9f7e03cd60e2e05f7a",
    generatorBody: operationalLogReportSource
  }
}

/** The digest each generator embedded in its own rendered body. */
export const helperCapabilityDigests = {
  maint: capabilityBodyDigest(helperCapabilityTargets.maint.generatorBody),
  ops: capabilityBodyDigest(helperCapabilityTargets.ops.generatorBody)
}

/** The subset of one target the comparison needs, without the whole generator body. */
export function evidenceTarget(target) {
  return {
    helper: target.helper,
    generatorBody: target.generatorBody,
    sourceHashDigest: helperCapabilityDigests[target.target]
  }
}

/**
 * The one `helperAttestation` entry of a capability report that belongs to `helper`, or null.
 * Never throws: a report that is not an object, carries no `helperAttestation` array, or lists no
 * matching helper (including a renamed field) yields null, and the caller decides what that means.
 *
 * @param {unknown} report the parsed `get_capability_report` reply
 * @param {string} helper
 * @returns {Record<string, unknown> | null}
 */
export function readHelperAttestation(report, helper) {
  const expected = String(helper).trim().toUpperCase()
  const entries = report?.helperAttestation
  if (!Array.isArray(entries)) return null
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue
    const declared = typeof entry.helper === "string" ? entry.helper.trim().toUpperCase() : ""
    if (declared === expected) return entry
  }
  return null
}

const mismatch = (mismatches, field, expected, actual) => {
  mismatches.push(
    `${field}: expected ${expected === undefined ? "absent" : JSON.stringify(expected)}, reported ${actual === undefined ? "absent" : JSON.stringify(actual)}`
  )
}

/** `OPERATION|<opcode>|<since>|<R|W>` for every operation row of an attestation, sorted. */
const attestationOperationRows = (operations) => {
  if (!Array.isArray(operations)) return []
  return operations
    .filter((operation) => operation && typeof operation === "object")
    .map(
      (operation) =>
        `OPERATION|${String(operation.opcode ?? "")}|${String(operation.since ?? "")}|${operation.write ? "W" : "R"}`
    )
    .sort()
}

/**
 * Compare one helper's attestation against the generator's intended state. Never throws and
 * always inspects every field, so one evidence file explains every divergence at once.
 *
 * The operation list is compared order-insensitively (sorted by the rendered row) because §3.2
 * fixes the row kinds and their order but not the order among operations, while
 * `parseHelperCapabilitiesPayload` preserves the helper's own order.
 *
 * @param {Record<string, unknown> | null} attestation
 * @param {{helper: string, expectedProtocol: {min: string, max: string}, expectedOperations: string[], packageName: string, transportRequest: string, transportTask: string, sourceHashDigest: string}} target
 * @returns {{ok: boolean, mismatches: string[]}}
 */
export function compareHelperAttestation(attestation, target) {
  const mismatches = []
  if (!attestation || typeof attestation !== "object") {
    mismatches.push(`helperAttestation: no entry for ${target.helper}`)
    return { ok: false, mismatches }
  }
  if (attestation.attestation !== "self-described")
    mismatch(mismatches, "attestation", "self-described", attestation.attestation)
  if (typeof attestation.helper !== "string")
    mismatch(mismatches, "helper", target.helper, undefined)
  else if (attestation.helper.trim().toUpperCase() !== target.helper.toUpperCase())
    mismatch(mismatches, "helper", target.helper, attestation.helper)
  if (attestation.minProtocol !== target.expectedProtocol.min)
    mismatch(
      mismatches,
      "minProtocol",
      target.expectedProtocol.min,
      attestation.minProtocol ?? null
    )
  if (attestation.maxProtocol !== target.expectedProtocol.max)
    mismatch(
      mismatches,
      "maxProtocol",
      target.expectedProtocol.max,
      attestation.maxProtocol ?? null
    )
  const expectedOperations = [...target.expectedOperations].sort()
  const actualOperations = attestationOperationRows(attestation.operations)
  if (actualOperations.join(",") !== expectedOperations.join(","))
    mismatch(mismatches, "operations", expectedOperations, actualOperations)
  if (attestation.sourceHash !== target.sourceHashDigest)
    mismatch(mismatches, "sourceHash", target.sourceHashDigest, attestation.sourceHash ?? null)
  if (attestation.packageName !== target.packageName)
    mismatch(mismatches, "packageName", target.packageName, attestation.packageName ?? null)
  const transport = `${target.transportRequest}|${target.transportTask}`
  if (attestation.sourceTransport !== undefined && attestation.sourceTransport !== transport)
    mismatch(mismatches, "sourceTransport", transport, attestation.sourceTransport)
  // The report carries a SINGLE transport value: the rendered SOURCE|TRANSPORT row's request
  // field (src/adt-backend.ts `payload.transport = fields[2]`), and it exposes no task field at
  // all, so the task is deliberately not compared. For these two targets the compared value is
  // the rendered provenance `GR2K923421`, which may legitimately differ from the live TADIR
  // assignment `GR2K923472`.
  if (attestation.transport !== target.transportRequest)
    mismatch(mismatches, "transport", target.transportRequest, attestation.transport ?? null)
  return { ok: mismatches.length === 0, mismatches }
}

const two = (value) => String(value).padStart(2, "0")

/**
 * Write one evidence record into the `path` directory, creating the directory and its parents.
 * The record is stored as `<stamp>-<milliseconds>[-n].json`; an existing file is never
 * overwritten, and a document already stored there keeps its own records.
 */
export async function writeCapabilitiesEvidence(path, record) {
  await mkdir(path, { recursive: true })
  const now = new Date()
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
  const writtenAt = now.toISOString()
  let attempt = 0
  for (;;) {
    const suffix = attempt === 0 ? "" : `-${attempt}`
    const target = join(
      path,
      `${stamp}-${String(now.getMilliseconds()).padStart(3, "0")}${suffix}.json`
    )
    let history = []
    try {
      const existing = JSON.parse(await readFile(target, "utf8"))
      if (Array.isArray(existing?.records)) history = existing.records
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    const document = { writtenAt, records: [...history, record] }
    try {
      await writeFile(target, JSON.stringify(document, null, 2), { flag: "wx" })
      return target
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      attempt += 1
      assert.ok(attempt < 100, `unable to allocate a free evidence file name under ${path}`)
    }
  }
}
