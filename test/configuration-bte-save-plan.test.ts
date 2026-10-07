import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import {
  attestConfigurationBteSaveApis,
  buildConfigurationBteSaveContainers as build
} from "../src/configuration-bte-save-plan.js"

// Returned SAP source/ABI and native layout, with their separate observation times.
const observed = JSON.parse(
  readFileSync(new URL("./fixtures/configuration-bte-vim-w200-r76.json", import.meta.url), "utf8")
)
function fixture() {
  const f = structuredClone(observed)
  f.after = { ...f.before, AKTIV: "" }
  return f
}

test("seven actual standard definitions attest through reads only", async () => {
  const calls: string[] = [],
    f = fixture()
  const pins = await attestConfigurationBteSaveApis(async (name) => {
    calls.push(name)
    return f.definitions[name]
  })
  assert.deepEqual(calls.sort(), Object.keys(f.definitions).sort())
  assert.equal(Object.keys(pins).length, 7)
  assert.equal(pins.CONTEXT_BUFFER_DELETE!.updateTask, true)
  assert.equal(pins.VIM_SET_NO_TR_DIALOG!.remoteEnabled, false)
})

test("changed source, ABI, group, connection and invocation flags reject and never replay reads", async () => {
  for (const patch of [
    { sourceFingerprint: "0".repeat(64) },
    { interfaceFingerprint: "0".repeat(64) },
    { functionGroup: "OTHER" },
    { functionName: "OTHER" },
    { connectionId: "w300" },
    { remoteEnabled: true },
    { updateTask: true },
    { updateTaskMode: "1" },
    { globalInterface: true }
  ]) {
    const f = fixture(),
      calls: string[] = []
    Object.assign(f.definitions.VIM_SET_NO_TR_DIALOG, patch)
    await assert.rejects(
      attestConfigurationBteSaveApis(async (name) => {
        calls.push(name)
        return f.definitions[name]
      }),
      /API_UNVERIFIED/
    )
    assert.equal(calls.length, 7)
    assert.equal(new Set(calls).size, 7)
  }
  await assert.rejects(
    attestConfigurationBteSaveApis(async () => {
      throw Error("Unavailable")
    }),
    /API_UNVERIFIED/
  )
})

test("actual ZFICHK layout encodes entity, complete text and three control characters", () => {
  const f = fixture(),
    r = build(f.metadata, f.before, f.after, f.texts)
  const c = r.languageCandidates[0]!
  // 44 entity characters + 62 text characters + action/mark/text-action.
  const base = "200" + "ZFICHK".padEnd(8) + "".padEnd(32)
  const text = "2001" + "ZFICHK".padEnd(8) + "FI CHECK".padEnd(50)
  assert.deepEqual(c.save.total, [base + " " + text + "U  "])
  assert.deepEqual(c.recover.total, [base + "X" + text + "U  "])
  assert.equal(c.save.total[0]!.length, 109)
  assert.deepEqual(c.save.extract, [])
  assert.deepEqual(c.recover.extract, [])
  assert.equal(r.executable, false)
  assert.equal(r.writeAvailable, false)
  assert.equal(r.nativeSerializationVerified, false)
  assert.equal(r.requireLockedFreshRead, true)
  assert.equal(r.selectExactlyOneAuthenticatedSapLanguage, true)
})

test("Chinese text and destination are retained; languages are separate alternatives, never one TOTAL batch", () => {
  const f = fixture()
  f.before.RFCDS = "DEST WITH SPACE"
  f.after.RFCDS = f.before.RFCDS
  f.texts[0].TXT50 = "财务检查 原值"
  f.texts.unshift({ ...f.texts[0], SPRAS: "E", TXT50: "Original English" })
  const r = build(f.metadata, f.before, f.after, f.texts)
  assert.deepEqual(
    r.languageCandidates.map((c) => c.language),
    ["1", "E"]
  )
  for (const c of r.languageCandidates) {
    const save = c.save.total[0]!,
      restore = c.recover.total[0]!
    assert.equal(c.save.total.length, 1)
    assert.equal(save.slice(11, 43), "DEST WITH SPACE".padEnd(32))
    assert.equal(save.slice(44, 106), restore.slice(44, 106))
    assert.equal(
      save.slice(56, 106),
      f.texts.find((t: { SPRAS: string }) => t.SPRAS === c.language).TXT50.padEnd(50)
    )
    assert.equal(save[107], " ")
    assert.equal(save[108], " ")
  }
  assert.deepEqual(build(f.metadata, f.before, f.after, [...f.texts].reverse()), r)
})

test("no-op leaves all action flags blank and no missing language is fabricated", () => {
  const f = fixture(),
    same = build(f.metadata, f.before, f.before, f.texts)
  assert.equal(same.languageCandidates[0]!.save.total[0]!.slice(-3), "   ")
  assert.deepEqual(same.languageCandidates[0]!.save, same.languageCandidates[0]!.recover)
  const empty = build(f.metadata, f.before, f.after, [])
  assert.deepEqual(empty.languageCandidates, [])
  assert.equal(empty.missingLogonLanguageRequiresNativeRead, true)
  assert.equal(empty.executable, false)
})

test("only AKTIV may differ; malformed fixed-width strings and foreign or repeated texts reject", () => {
  for (const patch of [
    { MANDT: "300" },
    { PRDKT: "ZOTHER" },
    { RFCDS: "OTHER" },
    { RFCDS: "x".repeat(33) },
    { AKTIV: "N" },
    { AKTIV: " " },
    { RFCDS: "\uD800" },
    { RFCDS: "\n" },
    { owner: "WYS" }
  ]) {
    const f = fixture()
    assert.throws(
      () => build(f.metadata, f.before, { ...f.after, ...patch }, f.texts),
      /BTE_SAVE_PLAN_/
    )
  }
  for (const patch of [
    { MANDT: "300" },
    { PRDKT: "ZOTHER" },
    { SPRAS: "" },
    { SPRAS: " " },
    { SPRAS: "EN" },
    { TXT50: "x".repeat(51) },
    { TXT50: "\uD800" },
    { TXT50: "\r" },
    { TXT50: "😀" }
  ]) {
    const f = fixture()
    Object.assign(f.texts[0], patch)
    assert.throws(() => build(f.metadata, f.before, f.after, f.texts), /BTE_SAVE_PLAN_/)
  }
  const f = fixture()
  assert.throws(
    () => build(f.metadata, f.before, f.after, [f.texts[0], f.texts[0]]),
    /TEXT_DUPLICATE/
  )
  assert.throws(
    () => build(f.metadata, f.before, f.after, Array(201).fill(f.texts[0])),
    /INPUT_INVALID/
  )
})

test("unexpected Unicode layout, keys or callbacks refuse instead of generating a misaligned write", () => {
  for (const patch of [
    { TABLEN: "44" },
    { AFTER_TABC: "86" },
    { TEXTTABLEN: "62" },
    { AFT_TXTTBC: "122" },
    { KEYLEN: "11" },
    { TEXTKEYLEN: "12" },
    { TEXTTAB: "OTHER" },
    { CLIDEP: "" },
    { BASTAB: "" },
    { NEWGENER: "X" },
    { FLAG: "X" },
    { RDONLYFLAG: "X" },
    { FRM_AF_SAV: "OTHER" },
    { FRM_BF_SAV: "OTHER" }
  ]) {
    const f = fixture()
    Object.assign(f.metadata.ET_HEADER[0], patch)
    assert.throws(() => build(f.metadata, f.before, f.after, f.texts), /LAYOUT_UNSUPPORTED/)
  }
  for (const patch of [
    { POSITION: "44" },
    { FLENGTH: "3" },
    { KEYFLAG: "" },
    { INTTYPE: "P" },
    { DATATYPE: "CHAR" },
    { TEXTTABFLD: "" },
    { BASTABNAME: "TBE24" }
  ]) {
    const f = fixture()
    Object.assign(f.metadata.ET_NAMTAB[4], patch)
    assert.throws(() => build(f.metadata, f.before, f.after, f.texts), /LAYOUT_UNSUPPORTED/)
  }
  const f = fixture()
  f.metadata.ET_EVENTS.push({ TABNAME: "TBE24", EVENT: "01", FORMNAME: "NEW_CALLBACK" })
  assert.throws(() => build(f.metadata, f.before, f.after, f.texts), /LAYOUT_UNSUPPORTED/)
})

test("fixture proves the actual native no-dialog CTS branch; reading definitions does not run it", () => {
  const f = fixture()
  const setter = f.definitions.VIM_SET_NO_TR_DIALOG.source.join("\n")
  const insert = f.definitions.VIM_TR_OBJECTS_INSERT.source.join("\n")
  const enqueue = f.definitions.VIEW_ENQUEUE.source.join("\n")
  assert.match(setter, /vim_no_dialog_req\s*=\s*i_nodialog/i)
  assert.match(insert, /IF\s+vim_no_dialog_req\s+EQ\s+abap_true/i)
  assert.match(insert, /CALL FUNCTION\s+'CTS_WBO_API_INSERT_OBJECTS'/i)
  assert.match(insert, /no_explicit_dbcommit\s*=\s*'X'/i)
  assert.match(enqueue, /PERFORM\s+enqueue_tab\s+USING\s+text_table_name/i)
})
