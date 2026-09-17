import { XMLValidator } from "fast-xml-parser"
import { fullParse } from "abap-adt-api/build/utilities.js"
import type { AdtHTTP, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js"
import { z } from "zod"

const ENDPOINT = "/sap/bc/adt/activation/inactiveobjects"
const INACTIVE_NAMESPACE = "http://www.sap.com/adt/inactivectsobjects"
const CORE_NAMESPACE = "http://www.sap.com/adt/core"

interface InactiveInventoryErrorDetails {
  rootName?: string | undefined
  targetUri?: string | undefined
  mainProgramUri?: string | undefined
}

export class InactiveInventoryError extends Error {
  readonly endpoint = ENDPOINT

  constructor(
    readonly code: string,
    readonly stage: "response_validation" | "root_parse" | "entry_parse",
    readonly details: InactiveInventoryErrorDetails = {}
  ) {
    const fields = [code, `stage=${stage}`, `endpoint=${ENDPOINT}`]
    if (details.rootName) fields.push(`root=${details.rootName}`)
    if (details.targetUri) fields.push(`target=${details.targetUri}`)
    if (details.mainProgramUri) fields.push(`mainProgram=${details.mainProgramUri}`)
    super(fields.join("; "))
    this.name = "InactiveInventoryError"
  }

  withContext(details: InactiveInventoryErrorDetails): InactiveInventoryError {
    return new InactiveInventoryError(this.code, this.stage, { ...this.details, ...details })
  }

  diagnostic() {
    return {
      code: this.code,
      stage: this.stage,
      endpoint: this.endpoint,
      rootName: this.details.rootName ?? null,
      targetUri: this.details.targetUri ?? null,
      mainProgramUri: this.details.mainProgramUri ?? null
    }
  }
}

const text = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\u0000-\u001f\u007f]*$/)
const uri = text(2048).refine((value) => {
  let parsed: URL
  let decodedPath: string
  try {
    parsed = new URL(value, "https://sap.invalid")
    decodedPath = decodeURIComponent(parsed.pathname)
  } catch {
    return false
  }
  const context = parsed.searchParams.get("context")
  const supportedPath =
    parsed.pathname.toLowerCase().startsWith("/sap/bc/adt/") ||
    parsed.pathname.toLowerCase().startsWith("/vit/wb/object_type/")
  return (
    supportedPath &&
    !/[\\\s#]/.test(parsed.pathname) &&
    !/[\u0000-\u001f\u007f\\#]/.test(decodedPath) &&
    !parsed.hash &&
    parsed.pathname === value.split("?")[0] &&
    [...parsed.searchParams.keys()].every((key) => key === "context") &&
    parsed.searchParams.getAll("context").length <= 1 &&
    (!parsed.search || (context !== null && /^\/sap\/bc\/adt\/[a-z0-9_/-]+$/i.test(context)))
  )
})
const reference = z.object({
  "@_adtcore:uri": uri,
  "@_adtcore:name": text(120)
    .min(1)
    .regex(/^[^<>&"']+$/),
  "@_adtcore:type": text(40)
    .min(1)
    .regex(/^[^<>&"']+$/),
  "@_adtcore:parentUri": z.union([z.literal(""), uri]).optional()
})
const element = z.object({
  "@_ioc:user": text(12),
  "@_ioc:deleted": z.enum(["true", "false", "1", "0"]),
  "ioc:ref": reference
})
export interface InactiveInventory {
  entries: Array<{
    uri: string
    name: string
    type: string
    user: string
    deleted: boolean
    parentUri?: string
  }>
  transportOnlyRecords: number
}

type XmlNode = Record<string, unknown>

function xmlNode(value: unknown): XmlNode | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as XmlNode)
    : undefined
}

function namespaceBindings(root: XmlNode): Map<string, string> {
  const bindings = new Map<string, string>()
  for (const [key, value] of Object.entries(root)) {
    if (typeof value !== "string") continue
    if (key === "@_xmlns") bindings.set("", value)
    else if (key.startsWith("@_xmlns:")) bindings.set(key.slice("@_xmlns:".length), value)
  }
  return bindings
}

function safeMetadataAttribute(value: unknown): boolean {
  return typeof value === "string" && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
}

function xmlName(key: string, attribute: boolean) {
  const value = attribute ? key.replace(/^@_/, "") : key
  const separator = value.indexOf(":")
  return separator < 0
    ? { prefix: "", local: value }
    : { prefix: value.slice(0, separator), local: value.slice(separator + 1) }
}

function namespaceFor(key: string, bindings: Map<string, string>, attribute: boolean): string {
  const name = xmlName(key, attribute)
  if (attribute && !name.prefix) return ""
  return bindings.get(name.prefix) ?? ""
}

function matchesName(
  key: string,
  local: string,
  namespace: string,
  bindings: Map<string, string>,
  attribute = false
): boolean {
  return (
    xmlName(key, attribute).local === local && namespaceFor(key, bindings, attribute) === namespace
  )
}

function member(
  node: XmlNode,
  local: string,
  namespace: string,
  bindings: Map<string, string>,
  attribute = false
): unknown {
  const keys = Object.keys(node).filter((key) =>
    matchesName(key, local, namespace, bindings, attribute)
  )
  if (keys.length > 1) {
    throw new InactiveInventoryError("INACTIVE_INVENTORY_ENTRY_INVALID", "entry_parse")
  }
  return keys.length ? node[keys[0]!] : undefined
}

function normalizeElement(value: unknown, bindings: Map<string, string>) {
  const node = xmlNode(value)
  const ref = xmlNode(node && member(node, "ref", INACTIVE_NAMESPACE, bindings))
  if (!node || !ref) {
    throw new InactiveInventoryError("INACTIVE_INVENTORY_ENTRY_INVALID", "entry_parse")
  }
  return {
    "@_ioc:user": member(node, "user", INACTIVE_NAMESPACE, bindings, true),
    "@_ioc:deleted": member(node, "deleted", INACTIVE_NAMESPACE, bindings, true),
    "ioc:ref": {
      "@_adtcore:uri": member(ref, "uri", CORE_NAMESPACE, bindings, true),
      "@_adtcore:name": member(ref, "name", CORE_NAMESPACE, bindings, true),
      "@_adtcore:type": member(ref, "type", CORE_NAMESPACE, bindings, true),
      "@_adtcore:parentUri": member(ref, "parentUri", CORE_NAMESPACE, bindings, true)
    }
  }
}

function parseCoreReferences(root: XmlNode, bindings: Map<string, string>): InactiveInventory {
  const raw = member(root, "objectReference", CORE_NAMESPACE, bindings)
  const rows = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
  if (rows.length > 5000) {
    throw new InactiveInventoryError("INACTIVE_INVENTORY_LIMIT_EXCEEDED", "entry_parse")
  }
  const entries: InactiveInventory["entries"] = []
  for (const row of rows) {
    const node = xmlNode(row)
    if (
      !node ||
      Object.entries(node).some(
        ([key, value]) => !key.startsWith("@_") || !safeMetadataAttribute(value)
      )
    ) {
      throw new InactiveInventoryError("INACTIVE_INVENTORY_ENTRY_INVALID", "entry_parse")
    }
    try {
      const parsed = reference.parse({
        "@_adtcore:uri": member(node, "uri", CORE_NAMESPACE, bindings, true),
        "@_adtcore:name": member(node, "name", CORE_NAMESPACE, bindings, true),
        "@_adtcore:type": member(node, "type", CORE_NAMESPACE, bindings, true),
        "@_adtcore:parentUri": member(node, "parentUri", CORE_NAMESPACE, bindings, true)
      })
      entries.push({
        uri: parsed["@_adtcore:uri"],
        name: parsed["@_adtcore:name"],
        type: parsed["@_adtcore:type"],
        ...(parsed["@_adtcore:parentUri"] !== undefined
          ? { parentUri: parsed["@_adtcore:parentUri"] }
          : {}),
        user: "",
        deleted: false
      })
    } catch (error) {
      if (error instanceof InactiveInventoryError) throw error
      throw new InactiveInventoryError("INACTIVE_INVENTORY_ENTRY_INVALID", "entry_parse")
    }
  }
  return { entries, transportOnlyRecords: 0 }
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
    throw new InactiveInventoryError("INACTIVE_INVENTORY_RESPONSE_INVALID", "response_validation")
  const document = fullParse(response.body, {
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true
  })
  const roots = Object.keys(document).filter((k) => !k.startsWith("?"))
  const rootName = roots.length === 1 ? roots[0]! : "multiple-or-missing"
  const root = roots.length === 1 ? xmlNode(document[rootName]) : undefined
  const bindings = root ? namespaceBindings(root) : new Map<string, string>()
  const rootLocalName = xmlName(rootName, false).local
  const rootNamespace = namespaceFor(rootName, bindings, false)
  const inactiveRoot = rootLocalName === "inactiveObjects" && rootNamespace === INACTIVE_NAMESPACE
  const coreReferencesRoot =
    rootLocalName === "objectReferences" && rootNamespace === CORE_NAMESPACE
  if (
    !root ||
    (!inactiveRoot && !coreReferencesRoot) ||
    Object.keys(root).some(
      (key) =>
        (key.startsWith("@_") && !safeMetadataAttribute(root[key])) ||
        (!key.startsWith("@_") &&
          !matchesName(
            key,
            inactiveRoot ? "entry" : "objectReference",
            inactiveRoot ? INACTIVE_NAMESPACE : CORE_NAMESPACE,
            bindings
          ))
    )
  ) {
    throw new InactiveInventoryError("INACTIVE_INVENTORY_ROOT_INVALID", "root_parse", {
      rootName: rootName.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 80) || "unknown"
    })
  }
  if (coreReferencesRoot) return parseCoreReferences(root, bindings)
  const raw = member(root, "entry", INACTIVE_NAMESPACE, bindings)
  const rows = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
  if (rows.length > 5000) {
    throw new InactiveInventoryError("INACTIVE_INVENTORY_LIMIT_EXCEEDED", "entry_parse")
  }
  const entries: InactiveInventory["entries"] = []
  let transportOnlyRecords = 0
  for (const row of rows) {
    const node = xmlNode(row)
    if (
      !node ||
      Object.keys(node).some(
        (key) =>
          !matchesName(key, "object", INACTIVE_NAMESPACE, bindings) &&
          !matchesName(key, "transport", INACTIVE_NAMESPACE, bindings)
      )
    ) {
      throw new InactiveInventoryError("INACTIVE_INVENTORY_ENTRY_INVALID", "entry_parse")
    }
    let parsed: {
      "ioc:object"?: z.infer<typeof element> | undefined
      "ioc:transport"?: z.infer<typeof element> | undefined
    }
    try {
      parsed = z
        .object({
          "ioc:object": element.optional(),
          "ioc:transport": element.optional()
        })
        .strict()
        .parse({
          "ioc:object": member(node, "object", INACTIVE_NAMESPACE, bindings)
            ? normalizeElement(member(node, "object", INACTIVE_NAMESPACE, bindings), bindings)
            : undefined,
          "ioc:transport": member(node, "transport", INACTIVE_NAMESPACE, bindings)
            ? normalizeElement(member(node, "transport", INACTIVE_NAMESPACE, bindings), bindings)
            : undefined
        })
    } catch (error) {
      if (error instanceof InactiveInventoryError) throw error
      throw new InactiveInventoryError("INACTIVE_INVENTORY_ENTRY_INVALID", "entry_parse")
    }
    if (!parsed["ioc:object"] && !parsed["ioc:transport"])
      throw new InactiveInventoryError("INACTIVE_INVENTORY_ENTRY_INVALID", "entry_parse")
    const item = parsed["ioc:object"]
    if (!item) {
      transportOnlyRecords++
      continue
    }
    entries.push({
      uri: item["ioc:ref"]["@_adtcore:uri"],
      name: item["ioc:ref"]["@_adtcore:name"],
      type: item["ioc:ref"]["@_adtcore:type"],
      ...(item["ioc:ref"]["@_adtcore:parentUri"] !== undefined
        ? { parentUri: item["ioc:ref"]["@_adtcore:parentUri"] }
        : {}),
      user: item["@_ioc:user"],
      deleted: ["true", "1"].includes(item["@_ioc:deleted"])
    })
  }
  return { entries, transportOnlyRecords }
}

export async function readInactiveInventory(http: Pick<AdtHTTP, "request">) {
  return parseInactiveInventory(
    await http.request(ENDPOINT, {
      headers: {
        Accept: "application/vnd.sap.adt.inactivectsobjects.v1+xml, application/xml;q=0.8"
      }
    })
  )
}
