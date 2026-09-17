import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { randomUUID, createHash } from "node:crypto"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { parseEndpoint } from "./run-mvp-batch2-sap.mjs"
import { RuntimeIdentity } from "../dist/src/runtime-info.js"
import { PRODUCT_VERSION } from "../dist/src/version.js"
import { SCI_E2_HELPER, SCI_E2_FINGERPRINT } from "../dist/src/sci-v2.js"
import {
  CONFIGURATION_TYPES,
  CONFIGURATION_MODE_DOMAIN,
  CONFIGURATION_MODE_FINGERPRINT
} from "../dist/src/configuration-preview.js"
import { redactDiagnosticText } from "../dist/src/runtime-diagnostics.js"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const rowHash = "f054a40edea645724fc3c06248216a606ae30fd18ba5c28d5a6c5fceaef4ea7c"
const sourceHash = "0eff6473675ddcd9ae5d667091fef802e082406f0a6415d4069ed7cbcb7b9aec"
const definitionHash = "4c617b912277d9d19b9e0bd8760dbfd53c541adb2129b30a5b040bb6cdd537ed"

export function selectionFor(mode) {
  if (mode === "sci-precheck" || mode === "sci-run")
    return {
      name: "run_sci_analysis",
      args: {
        connectionId: "w200",
        action: mode === "sci-precheck" ? "precheck" : "run",
        target: { objectType: "PROG", objectName: "ZCODEX_MVP3_UNIT" },
        profile: "syntax_critical_sql",
        acknowledgePotentialSideEffects: true
      }
    }
  if (mode === "unit")
    return {
      name: "run_unit_tests",
      args: { connectionId: "w200", objectName: "ZCODEX_MVP3_UNIT", outputFormat: "json" }
    }
  if (!["preview", "stale", "mode-valid", "mode-invalid"].includes(mode))
    throw new Error("Select a listed acceptance mode")
  return {
    name: "preview_configuration",
    args: {
      connectionId: "w200",
      plant: "809P",
      changes:
        mode === "mode-valid"
          ? { TPMODE: "E" }
          : mode === "mode-invalid"
            ? { TPMODE: "?" }
            : { DATBI: "20261209" },
      expectedRowFingerprint: mode === "stale" ? "0".repeat(64) : rowHash
    }
  }
}

export function checkResult(mode, result) {
  if (mode === "mode-invalid") {
    assert.equal(result.isError, true)
    assert.equal(result.content.length, 1)
    assert.equal(result.content[0].type, "text")
    assert.match(
      result.content[0].text,
      /^Error invoking preview_configuration: (?:Error: )?CONFIGURATION_DOMAIN_VALUE_INVALID: TPMODE$/
    )
    return
  }
  assert.equal(result.connectionId, "w200")
  if (mode === "sci-precheck" || mode === "sci-run") {
    const precheck = mode === "sci-precheck"
    assert.equal(result.engine, "SCI")
    assert.equal(result.nativeAtc, false)
    assert.equal(result.helper, SCI_E2_HELPER)
    assert.equal(result.helperFingerprint, SCI_E2_FINGERPRINT)
    assert.equal(result.qualityGate, "not_evaluated")
    assert.equal(result.coverage, "limited")
    assert.equal(result.execution, precheck ? "not_run" : "returned")
    assert.deepEqual(result.requestedTarget, selectionFor(mode).args.target)
    assert.deepEqual(result.scope, {
      objectType: "PROG",
      objectName: "ZCODEX_MVP3_UNIT",
      programName: "ZCODEX_MVP3_UNIT",
      packageName: "ZABAP"
    })
    assert.equal(result.profile, "SYNTAX_CRITICAL_SQL_V1")
    assert.deepEqual(
      result.selectedRules,
      [
        ["CL_CI_TEST_SYNTAX_CHECK", "001"],
        ["CL_CI_TEST_CRITICAL_STATEMENTS", "002"],
        ["CL_CI_TEST_SELECT_NESTED", "000"]
      ].map(([name, version]) => ({
        name,
        version,
        applicable: true,
        completion: precheck ? "not_run" : "not_attested"
      }))
    )
    assert.ok(Array.isArray(result.findings))
    assert.equal(result.returnedFindings, result.findings.length)
    assert.ok(result.findings.length <= 1000)
    if (precheck) {
      assert.equal(result.code, "PREFLIGHT_ONLY")
      assert.equal(result.totalFindings, undefined)
      assert.equal(result.returnedFindings, 0)
    } else {
      assert.ok(Number.isSafeInteger(result.totalFindings) && result.totalFindings >= 0)
      assert.equal(result.returnedFindings, Math.min(result.totalFindings, 1000))
      assert.equal(
        result.code,
        result.totalFindings === 0
          ? "NO_FINDINGS_UNVERIFIED"
          : result.totalFindings > 1000
            ? "TRUNCATED_LIMITED"
            : "FINDINGS_LIMITED"
      )
    }
    for (const finding of result.findings) {
      assert.ok(result.selectedRules.some((rule) => rule.name === finding.check))
      assert.ok(["E", "W", "N"].includes(finding.severity))
      for (const key of ["line", "column"])
        assert.ok(Number.isSafeInteger(finding[key]) && finding[key] >= 0)
      for (const key of ["include", "code", "message"]) assert.equal(typeof finding[key], "string")
      assert.equal(typeof finding.textTruncated, "boolean")
    }
    assert.equal(
      result.truncated,
      result.totalFindings > 1000 || result.findings.some((finding) => finding.textTruncated)
    )
    assert.ok(Array.isArray(result.limitations) && result.limitations.length > 0)
    return
  }
  if (mode === "unit") {
    assert.equal(result.objectName, "ZCODEX_MVP3_UNIT")
    assert.equal(result.engine, "ABAP Unit")
    assert.equal(result.activationPerformed, false)
    assert.equal(result.nativeAtc, false)
    assert.equal(result.status, "failed")
    assert.equal(result.total, 2)
    assert.equal(result.passed, 1)
    assert.equal(result.failed, 1)
    assert.equal(result.notExecutedClasses, 0)
    assert.equal(result.classes.length, 1)
    const cls = result.classes[0]
    assert.equal(cls.name.toUpperCase(), "LTC_ASSERTION_CONTROL")
    assert.ok(cls.alerts.every((a) => a.kind === "warning"))
    assert.equal(cls.methods.length, 2)
    const positive = cls.methods.find((m) => m.name.toUpperCase() === "ADDITION_PASSES")
    const negative = cls.methods.find((m) => m.name.toUpperCase() === "INTENTIONAL_FAILURE")
    assert.ok(positive && negative)
    assert.ok(positive.alerts.every((a) => a.kind === "warning"))
    assert.ok(negative.alerts.some((a) => a.kind === "failedAssertion"))
    return
  }
  assert.equal(result.client, "200")
  assert.equal(result.tableName, "ZTPMC_TPCFG")
  assert.equal(result.plant, "809P")
  assert.equal(result.readOnly, true)
  assert.equal(result.saveAvailable, false)
  assert.equal(result.validation, "structural_and_domain")
  assert.equal(result.businessValidation, "not_verified")
  assert.equal(result.snapshot, false)
  const types = CONFIGURATION_TYPES.map(([dataElement, dataType, length, domainName]) => ({
    dataElement,
    dataType,
    length,
    decimals: 0,
    domainName
  }))
  assert.equal(result.typeMetadataValidation, "matched")
  assert.deepEqual(result.typeMetadata, types)
  assert.equal(
    result.typeMetadataFingerprint,
    createHash("sha256").update(JSON.stringify(types)).digest("hex")
  )
  assert.equal(result.definitionFingerprint, definitionHash)
  assert.deepEqual(result.domainMetadata, {
    field: "TPMODE",
    domainName: CONFIGURATION_MODE_DOMAIN,
    fingerprint: CONFIGURATION_MODE_FINGERPRINT,
    allowedValues: ["", "E", "S"],
    scope: "fixed_values_only"
  })
  assert.match(result.rowFingerprint, /^[a-f0-9]{64}$/)
  if (mode === "stale") {
    assert.equal(result.status, "changed")
    assert.notEqual(result.rowFingerprint, "0".repeat(64))
    assert.equal(result.data, null)
    assert.equal(result.differences, null)
    return
  }
  assert.equal(result.status, "preview", "Baseline changed or read unavailable; do not retry")
  assert.equal(result.rowFingerprint, rowHash)
  assert.deepEqual(result.data, {
    MANDT: "200",
    WERKS: "809P",
    ACTIVE: "X",
    TPMODE: "S",
    DATAB: "20260908",
    DATBI: "20261208",
    CFGVERS: "000001",
    AENAM: "WYS",
    AEDAT: "20260908",
    AEZET: "091630"
  })
  assert.deepEqual(
    result.differences,
    mode === "mode-valid"
      ? [{ field: "TPMODE", from: "S", to: "E" }]
      : [{ field: "DATBI", from: "20261208", to: "20261209" }]
  )
  assert.deepEqual(result.domainValueValidation, {
    field: "TPMODE",
    effectiveValue: mode === "mode-valid" ? "E" : "S",
    status: "valid",
    currentValueValid: true
  })
}

async function main() {
  if (!stdin.isTTY || process.argv.length > 2) throw new Error("Interactive execution only")
  const rl = createInterface({ input: stdin, output: stdout })
  let mode, endpoint, selection
  try {
    console.log("One human-selected SAP acceptance. No saves, retries or automatic cleanup.")
    endpoint = parseEndpoint(
      (await rl.question("MCP URL [press Enter for 4847]: ")).trim() || "http://127.0.0.1:4847/mcp"
    )
    mode = (
      await rl.question(
        "Mode (preview / stale / mode-valid / mode-invalid / unit / sci-precheck / sci-run): "
      )
    ).trim()
    selection = selectionFor(mode)
    console.log(JSON.stringify(selection, null, 2))
    console.log("Report includes selected configuration values or Unit diagnostics.")
    console.log("Unit mode executes two tests; one assertion MUST fail. Source is checked first.")
    console.log(
      "SCI uses three limited rules, no Unit execution; empty findings are not a passed quality gate."
    )
    const token =
      mode === "unit"
        ? "RUN UNIT"
        : mode === "sci-run"
          ? "RUN SCI"
          : mode === "sci-precheck"
            ? "PRECHECK SCI"
            : "READ"
    if ((await rl.question(`Type ${token} to execute; anything else cancels: `)) !== token) return
  } finally {
    rl.close()
  }
  const startedAt = new Date().toISOString()
  const output = resolve(
    root,
    "../.doc",
    `mvp-batch3-sap-user-${startedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
  )
  await mkdir(output, { recursive: true })
  const report = {
    startedAt,
    mode,
    selection,
    status: "Partially Verified",
    selectedChecksPassed: false,
    automaticRetry: false,
    steps: [],
    limitations: [
      "Only the selected case is checked, not full third-batch acceptance.",
      "No save is requested; preview is not business validation or a transaction snapshot.",
      "Source preflight is not an atomic lock across Unit execution.",
      "Timeout is not cancellation; inspect the saved result before deciding next steps."
    ]
  }
  const client = new Client({ name: "mvp-batch3-human", version: PRODUCT_VERSION })
  const call = async (name, args, json = true) => {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 })
    report.steps.push({ name, response })
    if (mode === "mode-invalid" && name === selection.name) return response
    if (response.isError) throw new Error(`${name} returned a tool error`)
    const text = response.content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n")
    return json ? JSON.parse(text) : text
  }
  try {
    const local = await new RuntimeIdentity().report()
    assert.equal(local.status, "observed")
    await client.connect(new StreamableHTTPClientTransport(endpoint), { timeout: 15000 })
    const runtime = await call("get_runtime_info", {
      expectedVersion: PRODUCT_VERSION,
      expectedArtifactFingerprint: local.startupArtifact.artifactFingerprint
    })
    assert.equal(runtime.status, "observed")
    assert.equal(runtime.server?.version, PRODUCT_VERSION)
    for (const key of [
      "expectedVersion",
      "expectedArtifact",
      "diskSinceStartup",
      "moduleAndPackageVersion"
    ])
      assert.equal(runtime.checks?.[key], "match", `Candidate mismatch: ${key}`)
    if (mode === "unit" || mode === "sci-precheck" || mode === "sci-run") {
      const source = await call(
        "get_abap_object_lines",
        {
          connectionId: "w200",
          objectName: "ZCODEX_MVP3_UNIT",
          objectType: "PROG",
          startLine: 1,
          lineCount: 80
        },
        false
      )
      assert.ok(source.includes(`Full Source SHA-256: ${sourceHash}`), "Fixture source changed")
    }
    checkResult(mode, await call(selection.name, selection.args))
    report.selectedChecksPassed = true
  } catch (error) {
    report.status = "Failed"
    report.failure = String(error.message ?? error)
    process.exitCode = 1
  } finally {
    try {
      await client.close()
    } catch (error) {
      report.status = "Failed"
      report.closeFailure = String(error.message ?? error)
      process.exitCode = 1
    }
    report.finishedAt = new Date().toISOString()
    const path = resolve(output, "result.json")
    await writeFile(
      path,
      JSON.stringify(
        report,
        (_key, value) => (typeof value === "string" ? redactDiagnosticText(value) : value),
        2
      ) + "\n",
      { flag: "wx" }
    )
    console.log(`Result: ${report.status}\nReport: ${path}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main().catch((error) => {
    console.error(redactDiagnosticText(String(error.message ?? error)))
    process.exitCode = 1
  })
