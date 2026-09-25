import assert from "node:assert/strict"
import test from "node:test"
import { collectQrfcQueues } from "../src/qrfc-queues.js"
import { collectIdocStatus } from "../src/idoc-status.js"
import { parseSapDataQueryResponse } from "../src/data-query.js"
import type { RemoteFunctionRequest, SapBackend } from "../src/backend.js"

const readerDefinition = {
  functionName: "RFC_READ_TABLE",
  remoteEnabled: true,
  updateTask: false,
  sourceFingerprint: "7b9a603493673d26f75e555616b24d150e407ce03eff57e9c68f0b30b1ba0c2d",
  interfaceFingerprint: "d06cc5c1ce05960bde526ecf27e38606134146474cc8da19f93ac2abd3e48074"
}

let emptyHtml: unknown
try {
  parseSapDataQueryResponse({ body: "", status: 200, headers: { "content-type": "text/html" } })
} catch (error) {
  emptyHtml = error
}

type Double = {
  backend: Pick<SapBackend, "runQuery" | "callRemoteFunction">
  tables: string[]
}

/** The approved queue and IDoc tables are not in the shared mock, so rows are stored per table. */
function double(rows: Record<string, string[][]>): Double {
  const tables: string[] = []
  const backend = {
    runQuery: async () => {
      throw emptyHtml
    },
    callRemoteFunction: async (_connection: string, request: RemoteFunctionRequest) => {
      assert.equal(request.functionName, "RFC_READ_TABLE")
      const fields = request.inputParameters.FIELDS as { FIELDNAME: string }[]
      const table = String(request.inputParameters.QUERY_TABLE)
      tables.push(table)
      return {
        outputs: {
          FIELDS: fields,
          DATA: (rows[table] ?? []).map((values) => ({ WA: values.join("|") }))
        }
      }
    }
  }
  return { backend: backend as unknown as Double["backend"], tables }
}

const outboundRow = [
  "200", // MANDT
  "YCPICIPID", // ARFCIPID
  "PID1", // ARFCPID
  "123456", // ARFCTIME
  "0001", // ARFCTIDCNT
  "QUEUE_A", // QNAME
  "W200CLNT200", // DEST
  "000000000000000000000003", // QCOUNT
  " ", // HPQNAME
  " ", // NOSEND
  "READY", // QSTATE
  "000000000000000000000000", // QLOCKCNT
  "WF-BATCH", // QRFCUSER
  "Z_RFC_TARGET", // QRFCFNAM
  "20260925", // QRFCDATUM
  "101500", // QRFCUZEIT
  "00000002", // QLUWCNT
  " ", // QMAILED
  "" // ERRMESS
]

const inboundRow = [
  "200", // MANDT
  "YCPICIPID", // ARFCIPID
  "PID1", // ARFCPID
  "123456", // ARFCTIME
  "0001", // ARFCTIDCNT
  "QUEUE_IN", // QNAME
  "000000000000000000000005", // QCOUNT
  " ", // HPQNAME
  "W200CLNT200", // DEST
  " ", // NOSEND
  "RUNNING", // QSTATE
  "000000000000000000000000", // QLOCKCNT
  "WF-BATCH", // QRFCUSER
  "Z_RFC_TARGET", // QRFCFNAM
  "20260925", // QRFCDATUM
  "101600", // QRFCUZEIT
  "ORGTID000000000000000001", // ORGTID
  "00000004", // QLUWCNT
  " ", // BATCHPLA
  "20260925", // RETRYDATE
  "102000", // RETRYTIME
  "0002", // RETRYNR
  " ", // QMAILED
  "" // ERRMESS
]

test("qRFC queues map the approved columns and compose the TID", async () => {
  const { backend, tables } = double({ TRFCQOUT: [outboundRow], TRFCQIN: [inboundRow] })
  const result = await collectQrfcQueues(backend, "w200", {}, async () => readerDefinition)
  assert.equal(result.status, "ok")
  assert.equal(result.readOnly, true)
  assert.deepEqual(tables, ["TRFCQOUT", "TRFCQIN"], "TRFCQSTATE needs a destination or a flag")
  assert.equal(result.filters.includeLuwStates, false)
  assert.equal(result.counts.outbound, 1)
  assert.equal(result.counts.inbound, 1)
  assert.equal(result.inbound[0]!.queueName, "QUEUE_IN")
  assert.equal(result.inbound[0]!.originalTransactionId, "ORGTID000000000000000001")
  assert.equal(result.inbound[0]!.retryNumber, "0002")
  assert.equal(result.outbound[0]!.queueName, "QUEUE_A")
  assert.equal(result.outbound[0]!.state, "READY")
  assert.equal(result.outbound[0]!.transactionId, "YCPICIPIDPID11234560001")
  assert.match(result.notes.join(" "), /TRFCQSTATE was not read/)
  assert.match(result.notes.join(" "), /never translated/)
})

test("a destination filter also reads the LUW state table", async () => {
  const { backend, tables } = double({ TRFCQOUT: [outboundRow], TRFCQIN: [inboundRow] })
  const result = await collectQrfcQueues(
    backend,
    "w200",
    { destination: "W200CLNT200" },
    async () => readerDefinition
  )
  assert.deepEqual(tables, ["TRFCQOUT", "TRFCQIN", "TRFCQSTATE"])
  assert.equal(result.filters.includeLuwStates, true)
  assert.match(result.notes.join(" "), /TRFCQSTATE was read/)
})

test("an over-long queue filter is refused before SAP is called", async () => {
  const { backend, tables } = double({})
  await assert.rejects(
    collectQrfcQueues(backend, "w200", { queueName: "Q".repeat(25) }, async () => readerDefinition),
    /QRFC_QUEUE_SCOPE_INVALID/
  )
  assert.deepEqual(tables, [])
})

test("a bounded queue read reports truncation per table", async () => {
  const { backend } = double({ TRFCQOUT: [outboundRow, outboundRow, outboundRow], TRFCQIN: [] })
  const result = await collectQrfcQueues(
    backend,
    "w200",
    { maxRows: 2 },
    async () => readerDefinition
  )
  assert.equal(result.status, "partial")
  assert.equal(result.counts.outbound, 2)
  assert.equal(result.truncated.outbound, true)
  assert.equal(result.truncated.inbound, false)
})

const controlRow = [
  "200", // MANDT
  "0000000012345678", // DOCNUM
  "731", // DOCREL
  "53", // STATUS
  "ORDERS", // DOCTYP
  "1", // DIRECT
  "RECVPORT01", // RCVPOR
  "LS", // RCVPRT
  "RECEIVER01", // RCVPRN
  "SNDPORT01", // SNDPOR
  "LS", // SNDPRT
  "SENDER0001", // SNDPRN
  "ORDERS", // MESTYP
  "ORDERS05", // IDOCTP
  "", // CIMTYP
  "20260925", // CREDAT
  "101500", // CRETIM
  "20260925", // UPDDAT
  "101505", // UPDTIM
  " ", // TEST
  "00000000000000000001", // SERIAL
  "REFINT00000001", // REFINT
  "REFGRP00000001", // REFGRP
  "REFMES00000001", // REFMES
  "000017" // MAXSEGNUM
]

const statusRow = [
  "200", // MANDT
  "0000000012345678", // DOCNUM
  "20260925", // LOGDAT
  "101505", // LOGTIM
  "0000000000000001", // COUNTR
  "20260925", // CREDAT
  "101505", // CRETIM
  "53", // STATUS
  "WF-BATCH", // UNAME
  "Z_IDOC_REPORT", // REPID
  "IDOC_STATUS_SET", // ROUTID
  "IDOC_53", // STACOD
  "Application document posted", // STATXT
  "000001", // SEGNUM
  "", // SEGFELD
  "E", // STAMQU
  "ZIDOC", // STAMID
  "001", // STAMNO
  "TID00000000000000000001", // TID
  "" // APPL_LOG
]

test("IDoc status reads control records and status records for one document", async () => {
  const { backend, tables } = double({ EDIDC: [controlRow], EDIDS: [statusRow] })
  const result = await collectIdocStatus(
    backend,
    "w200",
    { docnum: "0000000012345678" },
    async () => readerDefinition
  )
  assert.equal(result.status, "ok")
  assert.deepEqual(tables, ["EDIDC", "EDIDS"])
  assert.equal(result.idocCount, 1)
  assert.equal(result.idocs[0]!.docnum, "0000000012345678")
  assert.equal(result.idocs[0]!.status, "53")
  assert.equal(result.idocs[0]!.sender.partnerNumber, "SENDER0001")
  assert.equal(result.idocs[0]!.receiver.partnerNumber, "RECEIVER01")
  assert.equal(result.statusRecordCount, 1)
  assert.equal(result.statusRecords[0]!.statusText, "Application document posted")
  assert.match(result.notes.join(" "), /none of them is translated here/)
})

test("IDoc status leaves the status table alone without a document filter", async () => {
  const { backend, tables } = double({ EDIDC: [controlRow] })
  const result = await collectIdocStatus(backend, "w200", {}, async () => readerDefinition)
  assert.deepEqual(tables, ["EDIDC"])
  assert.equal(result.statusRecords.length, 0)
  assert.match(result.notes.join(" "), /EDIDS was not read/)
})

test("an over-long IDoc filter is refused before SAP is called", async () => {
  const { backend, tables } = double({})
  await assert.rejects(
    collectIdocStatus(
      backend,
      "w200",
      { messageType: "M".repeat(31) },
      async () => readerDefinition
    ),
    /IDOC_STATUS_SCOPE_INVALID/
  )
  assert.deepEqual(tables, [])
})
