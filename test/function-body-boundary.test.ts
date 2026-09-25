import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import test from "node:test"

import { MockBackend } from "./mock-backend.js"
import { ToolService } from "../src/tools.js"

/**
 * Repository root of the running test file. The tests execute from `dist/test`, so the compiled
 * location is not the source location: walk up until the generated helper script is visible.
 */
function repositoryRoot(): string {
  let current = resolve(import.meta.dirname)
  while (!existsSync(join(current, "scripts", "bootstrap-sap-helper.ps1"))) {
    const parent = dirname(current)
    if (parent === current) throw new Error("Repository root not found")
    current = parent
  }
  return current
}

/**
 * Regression for the incident of 2026-09-25 (`ZPMC_FM_TP_STOCK_BALANCE`, SOURCE_MARKER_ERROR):
 * the SAP side function write located the implementation body only after the second `*"---`
 * interface separator, so a function module whose include keeps the interface in the parameter
 * tables (`FUNCTION ... .` followed directly by the body) was refused with
 * "Function interface skeleton marker is missing". w200 keeps function modules in both layouts, and
 * the service side already accepted both, so the boundary rule has to agree everywhere.
 */
test("a function module without an interface skeleton keeps its body writable", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  // ADT refuses a function module source PUT with HTTP 423 on this release, so the write must not
  // use that path at all: the ADT write is broken in the double to prove it is never reached.
  backend.adtSourceWriteRefused = true
  backend.seedFunctionModuleWithoutInterfaceSkeleton("ZCMCP_FM_9001", [
    "  CONCATENATE 'MCP:' iv_input INTO ev_output."
  ])
  const fileUri =
    "adt://w200/sap/bc/adt/functions/groups/zcmcp_fg_1501/fmodules/zcmcp_fm_9001/source/main"

  const result = await tools.replaceStringInObject({
    fileUri,
    oldString: "  CONCATENATE 'MCP:' iv_input INTO ev_output.",
    newString: "  CONCATENATE 'SEEDED:' iv_input INTO ev_output.",
    transportNumber: "GR2K923421"
  })

  assert.match(result, /through the SAP side function write/)
  assert.equal(backend.lastHelperRequest?.operation, "WRITE_FUNCTION_SOURCE")
  // Only the body travels to SAP: the FUNCTION statement and ENDFUNCTION stay in the include.
  assert.deepEqual(backend.lastHelperRequest?.source, [
    "  CONCATENATE 'SEEDED:' iv_input INTO ev_output."
  ])

  const reread = JSON.parse(
    await tools.readFunctionModuleInterface({
      functionName: "ZCMCP_FM_9001",
      connectionId: "w200"
    })
  ) as { source: string[] }
  assert.equal(reread.source[0], "FUNCTION ZCMCP_FM_9001.")
  assert.ok(reread.source.includes("  CONCATENATE 'SEEDED:' iv_input INTO ev_output."))
  assert.equal(reread.source.at(-1), "ENDFUNCTION.")
})

test("a complete include supplied in the plain layout is reduced to its body", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)
  // The reviewed implementation-source fingerprint hashes the JSON form of the body line array,
  // which is the convention `functionModuleResult` uses for `sourceFingerprint`.
  const expectedSourceFingerprint = createHash("sha256")
    .update(JSON.stringify(["  CONCATENATE 'MCP:' iv_input INTO ev_output."]))
    .digest("hex")

  await tools.writeFunctionModuleSource({
    functionName: "ZCMCP_FM_1501",
    functionGroup: "ZCMCP_FG_1501",
    expectedSourceFingerprint,
    // A caller may hand over the complete include of the layout that keeps the interface in the
    // parameter tables; the FUNCTION statement is not part of the body and must be dropped.
    source: [
      "FUNCTION ZCMCP_FM_1501.",
      "  CONCATENATE 'MCP:' iv_input INTO ev_output.",
      "ENDFUNCTION."
    ],
    packageName: "ZABAP",
    transportNumber: "GR2K923421",
    connectionId: "w200"
  })

  assert.deepEqual(backend.lastHelperRequest?.source, [
    "  CONCATENATE 'MCP:' iv_input INTO ev_output."
  ])
})

/**
 * The boundary rule exists in three places on purpose: the service (`src/tools.ts`), the SAP side
 * helper body that `scripts/bootstrap-sap-helper.ps1` installs, and the double that stands in for
 * SAP (`test/mock-backend.ts`). Keeping the copies is deliberate - the double must not agree with
 * the service by construction - but a copy that only knows one layout is what produced the incident,
 * so each copy must keep both. Removing either branch from any copy fails this test.
 */
test("every copy of the function body boundary rule keeps both include layouts", async () => {
  const copies: Array<{ file: string; skeleton: string[]; plain: string[] }> = [
    {
      file: "src/tools.ts",
      skeleton: ['/^\\*"-+$/', "separators[1]! + 1"],
      plain: ["/^FUNCTION\\b/i.test(firstNonBlank.trim())", 'endsWith(".")']
    },
    {
      file: "test/mock-backend.ts",
      skeleton: ['/^\\*"-+$/', "separators[1]! + 1"],
      plain: ['const firstCode = lines.findIndex((line) => line.trim() !== "")', 'endsWith(".")']
    },
    {
      file: "scripts/bootstrap-sap-helper.ps1",
      // The helper body is ABAP inside a PowerShell string, so the same rule reads as the separator
      // test on the second character and as the FUNCTION statement terminator search. The quotes are
      // doubled because the ABAP literal sits inside a single quoted PowerShell string.
      skeleton: ["lv_fm_body_line(2) = ''*\"''", "lv_fm_marker_count = 2"],
      plain: ["lv_fm_body_line(8) <> 'FUNCTION'", "lv_fm_body_text+lv_fm_body_length(1) = '.'"]
    }
  ]

  for (const copy of copies) {
    const text = await readFile(join(repositoryRoot(), copy.file), "utf8")
    for (const anchor of [...copy.skeleton, ...copy.plain]) {
      assert.ok(
        text.includes(anchor),
        `${copy.file} no longer implements the interface skeleton rule anchor ${JSON.stringify(anchor)}`
      )
    }
  }

  // The helper must still fail closed when neither layout matches, instead of writing anywhere.
  const helper = await readFile(join(repositoryRoot(), "scripts/bootstrap-sap-helper.ps1"), "utf8")
  assert.ok(helper.includes("ev_code = 'SOURCE_MARKER_ERROR'"))
  assert.ok(helper.includes("WRITE_FUNCTION_SOURCE|2.9|W"))
})
