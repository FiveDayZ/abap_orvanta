import assert from "node:assert/strict"
import test from "node:test"
import { ToolService } from "../src/tools.js"
import { observeWritePreChange } from "../src/write-prechange-evidence.js"
import { MockBackend } from "./mock-backend.js"

test("pre-change observation covers repository, DDIC, message, and source targets", async () => {
  const backend = new MockBackend()
  const tools = new ToolService(backend)

  const repository = await observeWritePreChange(
    "delete_module_pool",
    { programName: "ZMODULE_POOL" },
    "w200",
    "program ZMODULE_POOL",
    backend,
    tools
  )
  assert.equal(repository.exists, true)
  assert.equal(repository.active, true)
  assert.equal(repository.packageName, "ZABAP")
  assert.equal(repository.requestNumber, "GR2K923421")
  assert.equal(repository.taskNumber, "GR2K923422")

  const ddic = await observeWritePreChange(
    "upsert_ddic_domain",
    { objectName: "ZDOMAIN_MISSING" },
    "w200",
    "domain object ZDOMAIN_MISSING",
    backend,
    tools
  )
  assert.equal(ddic.exists, false)
  assert.equal(ddic.observationStatus, "complete")

  const message = await observeWritePreChange(
    "create_abap_message_class",
    { messageClass: "ZMESSAGE_MISSING" },
    "w200",
    "message class ZMESSAGE_MISSING",
    backend,
    tools
  )
  assert.equal(message.exists, false)

  const source = await observeWritePreChange(
    "manage_text_elements",
    { objectName: "ZREPORT_DEMO", objectType: "PROGRAM" },
    "w200",
    "program ZREPORT_DEMO",
    backend,
    tools
  )
  assert.equal(source.exists, true)
  assert.equal(source.active, true)
  assert.equal(source.packageName, "ZABAP")
  assert.match(String(source.fingerprint), /^[a-f0-9]{64}$/)
  assert.match(source.observedAt, /^2026-/)
})
