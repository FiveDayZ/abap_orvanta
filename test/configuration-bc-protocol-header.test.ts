import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { configurationBcOwnerInclude } from "../src/configuration-bc-owner-api.js"
import { configurationBcOwnerFunctionPins } from "../src/configuration-bc-owner-pins.js"

const observed = JSON.parse(
  readFileSync(
    new URL("./fixtures/scpr-activ-protocol-write-w200-r69.json", import.meta.url),
    "utf8"
  )
) as { source: string[]; sourceFingerprint: string; interfaceFingerprint: string }

// Interpret only the emitted protocol TABLES payload, not SAP SQL or commit behavior.
function emittedRows(flag: string, marker: string) {
  const source = configurationBcOwnerInclude.source.join("\n")
  const start = source.indexOf("ls_log-act_id = p_opts-act_id.")
  const end = source.indexOf("CALL FUNCTION 'SCPR_ACTIV_PROTOCOL_WRITE'", start)
  assert.ok(start >= 0 && end > start)
  const values: Record<string, string> = {
    "p_opts-act_id": "00000000000000000000000000000001",
    "p_opts-act_date": "20261007",
    "p_opts-act_time": "081601",
    "sy-uname": "WYS",
    "sy-sysid": "GR2",
    p_flag: flag,
    p_marker: marker
  }
  const row: Record<string, string> = {},
    rows: Record<string, string>[] = []
  let enabled = true
  const payload = source
    .slice(start, end)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith('"'))
    .join("\n")
  for (const statement of payload.split(".")) {
    const s = statement.trim()
    if (!s || s.startsWith('"')) continue
    const assignment = /^ls_log-(\w+) = (.+)$/.exec(s)
    if (assignment) {
      const expression = assignment[2]!.trim()
      row[assignment[1]!] = expression.startsWith("'")
        ? expression.slice(1, -1)
        : values[expression]!
      assert.equal(typeof row[assignment[1]!], "string", "unknown emitted assignment")
    } else if (s === "APPEND ls_log TO lt_log") {
      if (enabled) rows.push({ ...row })
    } else if (s === "IF p_flag = 'H'") enabled = flag === "H"
    else if (s === "ENDIF") enabled = true
    else assert.fail("Unreviewed emitted payload statement: " + s)
  }
  return rows
}

type Header = {
  act_id: string
  modifier: string
  actoptions: string
  trno_cust: string
  act_end: string
}

// Limited model of the actual 134-line w200 standard source's insert/update branches.
// It deliberately does not prove execution in ABAP or persistence on R/3*.
function standardHeader(rows: Record<string, string>[], existing?: Header) {
  let header = existing ? { ...existing } : undefined
  for (const row of rows) {
    if (!header) {
      header = {
        act_id: row.act_id!,
        modifier: row.modifier!,
        actoptions: row.actoptions!,
        trno_cust: "",
        act_end: ""
      }
    } else {
      if (row.protoflag === "E") {
        header.actoptions = row.actoptions!
        header.act_end = "server_timestamp"
      }
      if (row.protoflag === "R") header.act_end = ""
      if (row.trno_cust) header.trno_cust = row.trno_cust
    }
  }
  return header!
}

test("real w200 protocol source records the customizing task only in its existing-header branch", () => {
  const pin = configurationBcOwnerFunctionPins.SCPR_ACTIV_PROTOCOL_WRITE
  assert.ok(pin)
  assert.equal(observed.sourceFingerprint, pin.source)
  assert.equal(observed.interfaceFingerprint, pin.interface)
  const source = observed.source.join("\n")
  const start = observed.source.findIndex((line) => line.trim() === "IF sy-subrc <> 0.")
  assert.ok(start >= 0)
  let depth = 1,
    end = -1
  for (let i = start + 1; i < observed.source.length; i++) {
    const statement = observed.source[i]!.trim()
    if (statement.startsWith("IF ")) depth++
    if (statement === "ENDIF.") depth--
    if (statement === "ELSE." && depth === 1) {
      end = i
      break
    }
  }
  assert.ok(end > start)
  const insertion = observed.source.slice(start, end).join("\n")
  assert.ok(insertion.includes("INSERT scpracpp connection R/3*"))
  assert.ok(!insertion.includes("scpracpp-trno_cust"))
  assert.ok(source.includes("scpracpp-trno_cust = scprerrprt-trno_cust"))
})

test("first H payload reproduces the old missing-task failure and completes the header in one standard call", () => {
  const rows = emittedRows("H", "A:B:operation:")
  assert.equal(standardHeader(rows.slice(0, 1)).trno_cust, "")
  const header = standardHeader(rows)
  assert.equal(header.trno_cust, "GR2K923430")
  assert.equal(header.actoptions, "A:B:operation:")
  assert.equal(header.act_end, "")
  assert.equal(new Set(rows.map((row) => row.act_id)).size, 1)
})

test("E completion and R failure retain one protocol row and preserve the same authenticated header", () => {
  const begin = standardHeader(emittedRows("H", "A:B:operation:"))
  const completedRows = emittedRows("E", "A:E:operation:frame")
  assert.equal(completedRows.length, 1)
  const completed = standardHeader(completedRows, begin)
  assert.equal(completed.actoptions, "A:E:operation:frame")
  assert.equal(completed.act_end, "server_timestamp")
  assert.equal(completed.act_id, begin.act_id)
  assert.equal(completed.modifier, "WYS")
  assert.equal(completed.trno_cust, "GR2K923430")
  const failedRows = emittedRows("R", "A:B:operation:")
  assert.equal(failedRows.length, 1)
  assert.equal(standardHeader(failedRows, completed).act_end, "")
})
