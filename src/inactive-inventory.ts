import { XMLValidator } from "fast-xml-parser"
import { fullParse } from "abap-adt-api/build/utilities.js"
import type { AdtHTTP, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js"
import { z } from "zod"

const text = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\u0000-\u001f\u007f]*$/)
const uri = text(2048).refine(
  (value) =>
    value.startsWith("/sap/bc/adt/") &&
    !/[%\\\s?#]/.test(value) &&
    new URL(value, "https://sap.invalid").pathname === value
)
const reference = z.object({
  "@_adtcore:uri": uri,
  "@_adtcore:name": text(120).min(1),
  "@_adtcore:type": text(40).min(1)
})
const element = z.object({
  "@_ioc:user": text(12),
  "@_ioc:deleted": z.enum(["true", "false", "1", "0"]),
  "ioc:ref": reference
})
export interface InactiveInventory {
  entries: Array<{ uri: string; name: string; type: string; user: string; deleted: boolean }>
  transportOnlyRecords: number
}

export function parseInactiveInventory(response: HttpClientResponse): InactiveInventory {
  const media = String(
    Object.entries(response.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? ""
  )
    .split(";")[0]!
    .trim()
    .toLowerCase()
  if (
    response.status < 200 ||
    response.status >= 300 ||
    !(media === "application/xml" || media === "text/xml" || media.endsWith("+xml")) ||
    Buffer.byteLength(response.body) > 4 * 1024 * 1024 ||
    /<!DOCTYPE|<!ENTITY/i.test(response.body) ||
    XMLValidator.validate(response.body) !== true
  )
    throw new Error("INACTIVE_INVENTORY_RESPONSE_INVALID")
  const document = fullParse(response.body, {
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true
  })
  const roots = Object.keys(document).filter((k) => !k.startsWith("?"))
  if (roots.length !== 1 || roots[0] !== "ioc:inactiveObjects")
    throw new Error("INACTIVE_INVENTORY_ROOT_INVALID")
  const root = document["ioc:inactiveObjects"]
  if (
    root !== "" &&
    (!root ||
      typeof root !== "object" ||
      Array.isArray(root) ||
      Object.keys(root).some((k) => k !== "ioc:entry" && !k.startsWith("@_xmlns")))
  )
    throw new Error("INACTIVE_INVENTORY_ROOT_INVALID")
  const raw = root === "" ? undefined : root["ioc:entry"]
  const rows = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
  if (rows.length > 5000) throw new Error("INACTIVE_INVENTORY_LIMIT_EXCEEDED")
  const entries: InactiveInventory["entries"] = []
  let transportOnlyRecords = 0
  for (const row of rows) {
    const parsed = z
      .object({
        "ioc:object": element.optional(),
        "ioc:transport": element.optional()
      })
      .strict()
      .parse(row)
    if (!parsed["ioc:object"] && !parsed["ioc:transport"])
      throw new Error("INACTIVE_INVENTORY_ENTRY_INVALID")
    const item = parsed["ioc:object"]
    if (!item) {
      transportOnlyRecords++
      continue
    }
    entries.push({
      uri: item["ioc:ref"]["@_adtcore:uri"],
      name: item["ioc:ref"]["@_adtcore:name"],
      type: item["ioc:ref"]["@_adtcore:type"],
      user: item["@_ioc:user"],
      deleted: ["true", "1"].includes(item["@_ioc:deleted"])
    })
  }
  return { entries, transportOnlyRecords }
}

export async function readInactiveInventory(http: Pick<AdtHTTP, "request">) {
  return parseInactiveInventory(
    await http.request("/sap/bc/adt/activation/inactiveobjects", {
      headers: {
        Accept: "application/vnd.sap.adt.inactivectsobjects.v1+xml, application/xml;q=0.8"
      }
    })
  )
}
