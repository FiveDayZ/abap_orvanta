import assert from "node:assert/strict"
import test from "node:test"
import type { HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js"
import { parseInactiveInventory, readInactiveInventory } from "../src/inactive-inventory.js"

const wrap = (body: string) =>
  `<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/adt/inactivectsobjects" xmlns:adtcore="http://www.sap.com/adt/core">${body}</ioc:inactiveObjects>`
const entry = `<ioc:entry><ioc:object ioc:user="USER" ioc:deleted="false"><ioc:ref adtcore:uri="/sap/bc/adt/programs/programs/zreport" adtcore:type="PROG/P" adtcore:name="ZREPORT"/></ioc:object></ioc:entry>`
const response = (body: string, media = "application/xml"): HttpClientResponse => ({
  status: 200,
  statusText: "OK",
  headers: { "content-type": media },
  body
})

test("inactive inventory retains exact URI and deletion state, including an explicit empty root", () => {
  const parsed = parseInactiveInventory(response(wrap(entry)))
  assert.equal(parsed.entries[0]!.name, "ZREPORT")
  assert.equal(parsed.entries[0]!.deleted, false)
  assert.equal(parsed.transportOnlyRecords, 0)
  assert.deepEqual(parseInactiveInventory(response(wrap(""))).entries, [])
  const transportOnly = entry.replaceAll("ioc:object", "ioc:transport")
  assert.equal(parseInactiveInventory(response(wrap(transportOnly))).transportOnlyRecords, 1)
})

test("inactive inventory identifies namespaces by URI instead of fixed XML prefixes", () => {
  const body = `<inv:inactiveObjects xmlns:inv="http://www.sap.com/adt/inactivectsobjects" xmlns:core="http://www.sap.com/adt/core" inv:version="1"><inv:entry><inv:object inv:user="USER" inv:deleted="false"><inv:ref core:uri="/sap/bc/adt/programs/includes/zreport_top?context=/sap/bc/adt/programs/programs/zreport" core:type="PROG/I" core:name="ZREPORT_TOP" core:parentUri="/sap/bc/adt/programs/programs/zreport"/></inv:object></inv:entry></inv:inactiveObjects>`
  const parsed = parseInactiveInventory(response(body))
  assert.equal(parsed.entries[0]!.name, "ZREPORT_TOP")
  assert.equal(parsed.entries[0]!.parentUri, "/sap/bc/adt/programs/programs/zreport")
})

test("inactive inventory accepts the ECC 7.31 core objectReferences response", () => {
  const body = `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:objectReference adtcore:uri="/sap/bc/adt/functions/groups/zca_fgf_h" adtcore:type="FUGR/F" adtcore:name="ZCA_FGF_H"/><adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_abap_act_ui5" adtcore:type="CLAS/OC" adtcore:name="ZCL_ABAP_ACT_UI5"/></adtcore:objectReferences>`
  const parsed = parseInactiveInventory(
    response(body, "application/vnd.sap.adt.repository.objref.v1+xml")
  )
  assert.deepEqual(
    parsed.entries.map(({ name, user, deleted }) => ({ name, user, deleted })),
    [
      { name: "ZCA_FGF_H", user: "", deleted: false },
      { name: "ZCL_ABAP_ACT_UI5", user: "", deleted: false }
    ]
  )
  assert.equal(parsed.transportOnlyRecords, 0)
})

test("inactive inventory accepts ECC 7.31 legacy and padded object references", () => {
  const body = `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:objectReference adtcore:uri="/sap/bc/adt/programs/includes/ztestp0980" adtcore:type="PROG/I" adtcore:name="ZTESTP0980"/><adtcore:objectReference adtcore:uri="/vit/wb/object_type/dtelde/zdsjjfkf" adtcore:type="DTEL/DE" adtcore:name="ZDSJJFKF"/><adtcore:objectReference adtcore:uri="/sap/bc/adt/wdy/wdyviews/ztestwd_01%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20view_01" adtcore:type="WDYN/WZ" adtcore:name="ZTESTWD_01                    VIEW_01"/></adtcore:objectReferences>`
  const parsed = parseInactiveInventory(
    response(body, "application/vnd.sap.adt.repository.objref.v1+xml")
  )
  assert.deepEqual(
    parsed.entries.map(({ uri, name, parentUri }) => ({ uri, name, parentUri })),
    [
      {
        uri: "/sap/bc/adt/programs/includes/ztestp0980",
        name: "ZTESTP0980",
        parentUri: undefined
      },
      {
        uri: "/vit/wb/object_type/dtelde/zdsjjfkf",
        name: "ZDSJJFKF",
        parentUri: undefined
      },
      {
        uri: "/sap/bc/adt/wdy/wdyviews/ztestwd_01%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20view_01",
        name: "ZTESTWD_01                    VIEW_01",
        parentUri: undefined
      }
    ]
  )
})

test("inactive inventory refuses HTML, unexpected children, invalid entries and external URIs", () => {
  for (const value of [
    response("<html/>", "text/html"),
    response("<html/>"),
    response(wrap("<unexpected/>")),
    response(wrap("<ioc:entry/>")),
    response(wrap(entry.replace('ioc:deleted="false"', 'ioc:deleted="maybe"'))),
    response(
      `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:objectReference adtcore:uri="https://other.invalid/" adtcore:type="CLAS/OC" adtcore:name="ZCL_BAD"/></adtcore:objectReferences>`
    ),
    response(
      wrap(entry.replace("/sap/bc/adt/programs/programs/zreport", "https://other.invalid/"))
    ),
    response(
      `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:objectReference adtcore:uri="/sap/bc/adt/programs/programs/zreport%5Cbad" adtcore:type="PROG/P" adtcore:name="ZREPORT"/></adtcore:objectReferences>`
    ),
    response("<!DOCTYPE x><ioc:inactiveObjects/>")
  ])
    assert.throws(() => parseInactiveInventory(value))
})

test("inactive inventory issues one read and never retries malformed responses", async () => {
  let calls = 0
  await assert.rejects(
    readInactiveInventory({
      async request(path) {
        calls++
        assert.equal(path, "/sap/bc/adt/activation/inactiveobjects")
        return response("<html/>", "text/html")
      }
    })
  )
  assert.equal(calls, 1)
})
