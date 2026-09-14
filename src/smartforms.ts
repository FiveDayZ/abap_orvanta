import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { XMLParser, XMLValidator } from "fast-xml-parser"
import { z } from "zod"
import type { SapBackend } from "./backend.js"

const MAX_XML_BYTES = 1024 * 1024
const formName = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[ZY][A-Z0-9_]{0,29}$/)
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)
const common = {
  connectionId: z
    .string()
    .regex(/^[a-z0-9_-]{1,100}$/i)
    .transform((v) => v.toLowerCase()),
  formName,
  language: z
    .string()
    .regex(/^[A-Z0-9]$/)
    .describe("SAP internal one-character language, e.g. E or 1")
}
export const readSmartformSchema = z
  .object({
    ...common,
    formName: z
      .string()
      .trim()
      .toUpperCase()
      .max(30)
      .regex(/^(?:[A-Z][A-Z0-9_]*|\/[A-Z0-9_]+\/[A-Z][A-Z0-9_]*)$/),
    version: z.enum(["active", "saved"]).default("saved")
  })
  .strict()
const write = {
  ...common,
  packageName: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^\$TMP$|^[ZY][A-Z0-9_]{0,29}$/),
  transportNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{3}K[0-9]{6}$/)
    .describe(
      "Existing modifiable development task owned by the authenticated SAP user; omit for $TMP"
    )
    .optional(),
  operationId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/)
}
const xml = z
  .string()
  .min(1)
  .max(MAX_XML_BYTES)
  .superRefine((value, context) => {
    try {
      validateSmartformXml(value)
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expected a complete SMARTFORM XML document (at most 1 MiB), without DTD/entities"
      })
    }
  })
export const createSmartformSchema = z.object({ ...write, xml }).strict()
export const saveSmartformSchema = z
  .object({ ...write, xml, expectedFingerprint: fingerprint })
  .strict()
export const activateSmartformSchema = z
  .object({ ...write, expectedFingerprint: fingerprint })
  .strict()

export type SmartformRequest = {
  action: "READ" | "CREATE" | "SAVE" | "ACTIVATE"
  formName: string
  language: string
  version: "active" | "saved"
  xml?: string
  expectedFingerprint?: string
  packageName?: string
  transportNumber?: string
}
const responseSchema = z
  .object({
    protocol: z.literal("1"),
    status: z.enum(["S", "E"]),
    code: z.string().min(1),
    message: z.string(),
    formName: z.string(),
    language: z.string(),
    version: z.enum(["active", "saved"]),
    xml: z.string().max(MAX_XML_BYTES),
    fingerprint: z.string(),
    packageName: z.string(),
    active: z.enum(["", "X"]),
    inactive: z.enum(["", "X"]),
    requestNumber: z.string()
  })
  .strict()
export type SmartformResponse = z.infer<typeof responseSchema>

export function validateSmartformXml(value: string): void {
  const bytes = Buffer.byteLength(value, "utf8")
  if (bytes > MAX_XML_BYTES) throw new Error(`SMARTFORM_XML_INVALID: UTF8_LIMIT bytes=${bytes}`)
  if (/<!DOCTYPE|<!ENTITY/i.test(value))
    throw new Error(`SMARTFORM_XML_INVALID: FORBIDDEN_DECLARATION bytes=${bytes}`)
  const validation = XMLValidator.validate(value)
  if (validation !== true) {
    // Parser messages may contain form text; expose only position and size.
    throw new Error(
      `SMARTFORM_XML_INVALID: SYNTAX bytes=${bytes} line=${validation.err.line} column=${validation.err.col} code=${validation.err.code} first=${value.codePointAt(0)?.toString(16) ?? "none"} unclosed=${validation.err.msg.startsWith("Invalid '")}`
    )
  }
  // Match XMLValidator's handling of the optional leading byte order mark.
  const doc = new XMLParser({
    ignoreAttributes: false,
    ignorePiTags: true,
    cdataPropName: "#cdata",
    parseTagValue: false,
    trimValues: false
  }).parse(value.startsWith("\uFEFF") ? value.slice(1) : value)
  // XML permits whitespace outside its single document element.
  // Keep CDATA separate so invalid document-level CDATA cannot pass as whitespace.
  const roots = Object.keys(doc).filter(
    (key) => !(key === "#text" && typeof doc[key] === "string" && /^[ \t\r\n]*$/.test(doc[key]))
  )
  const key = roots[0] ?? ""
  const prefix = key.includes(":") ? key.split(":")[0] + ":" : ""
  const root = doc[key]
  if (
    roots.length !== 1 ||
    key !== `${prefix}SMARTFORM` ||
    !root ||
    Array.isArray(root) ||
    root[prefix ? `@_xmlns:${prefix.slice(0, -1)}` : "@_xmlns"] !==
      "urn:sap-com:SmartForms:2000:internal-structure"
  )
    // Bounded structural metadata only; never include form text or attribute values.
    throw new Error(
      `SMARTFORM_XML_ROOT_INVALID: ${JSON.stringify({
        roots: roots.slice(0, 8).map((name) => name.slice(0, 100)),
        rootCount: roots.length,
        documentTextLength: typeof doc["#text"] === "string" ? doc["#text"].length : 0,
        documentTextIsXmlWhitespace:
          typeof doc["#text"] === "string" && /^[ \t\r\n]*$/.test(doc["#text"]),
        rootType: Array.isArray(root) ? "array" : typeof root,
        attributes:
          root && typeof root === "object"
            ? Object.keys(root)
                .filter((name) => name.startsWith("@_"))
                .slice(0, 16)
                .map((name) => name.slice(0, 100))
            : [],
        namespaceMatches:
          root && typeof root === "object"
            ? Object.entries(root)
                .filter(([, value]) => value === "urn:sap-com:SmartForms:2000:internal-structure")
                .map(([name]) => name.slice(0, 100))
                .slice(0, 8)
            : []
      })}`
    )
}

export function buildSmartformEnvelope(request: SmartformRequest): string {
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#13;")
  const fields = {
    IV_ACTION: request.action,
    IV_FORMNAME: request.formName,
    IV_LANGUAGE: request.language,
    IV_VERSION: request.version,
    IV_XML: request.xml ?? "",
    IV_EXPECTED: request.expectedFingerprint ?? "",
    IV_PACKAGE: request.packageName ?? "",
    IV_TRANSPORT: request.transportNumber ?? ""
  }
  return (
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
    '<n:Z_ORVANTA_SMARTFORM_API xmlns:n="urn:sap-com:document:sap:rfc:functions">' +
    Object.entries(fields)
      .map(([key, value]) => `<${key}>${escape(value)}</${key}>`)
      .join("") +
    "</n:Z_ORVANTA_SMARTFORM_API></soap:Body></soap:Envelope>"
  )
}

export function parseSmartformResponse(body: string): SmartformResponse {
  if (/<!DOCTYPE|<!ENTITY/i.test(body) || XMLValidator.validate(body) !== true)
    throw new Error("SMARTFORM_SOAP_INVALID")
  const doc = new XMLParser({
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: false,
    // SAP SOAP uses decimal/hex character references as well as named entities.
    htmlEntities: true
  }).parse(body)
  // SAP SOAP uses the literal local element name including '.Response'.
  const result = doc?.Envelope?.Body?.["Z_ORVANTA_SMARTFORM_API.Response"]
  if (!result || Array.isArray(result)) throw new Error("SMARTFORM_SOAP_RESPONSE_MISSING")
  const names = {
    protocol: "PROTOCOL",
    status: "STATUS",
    code: "CODE",
    message: "MESSAGE",
    formName: "FORMNAME",
    language: "LANGUAGE",
    version: "VERSION",
    xml: "XML",
    fingerprint: "FINGERPRINT",
    packageName: "PACKAGE",
    active: "ACTIVE",
    inactive: "INACTIVE",
    requestNumber: "REQUEST"
  }
  return responseSchema.parse(
    Object.fromEntries(Object.entries(names).map(([key, field]) => [key, result[`EV_${field}`]]))
  )
}

export class SmartformService {
  constructor(
    private readonly backend: Pick<SapBackend, "callSmartform">,
    private readonly stateRoot?: string
  ) {}

  async read(raw: z.input<typeof readSmartformSchema>) {
    const input = readSmartformSchema.parse(raw)
    const result = await this.backend.callSmartform(input.connectionId, {
      ...input,
      action: "READ"
    })
    return this.checked(input.connectionId, input, result)
  }

  async write(
    action: "CREATE" | "SAVE" | "ACTIVATE",
    raw: unknown,
    beforeInvoke?: () => Promise<void>
  ) {
    const input =
      action === "CREATE"
        ? createSmartformSchema.parse(raw)
        : action === "SAVE"
          ? saveSmartformSchema.parse(raw)
          : activateSmartformSchema.parse(raw)
    if ((input.packageName !== "$TMP") !== Boolean(input.transportNumber))
      throw new Error("SMARTFORM_TRANSPORT_REQUIRED_FOR_NONLOCAL_ONLY")
    if (!this.stateRoot) throw new Error("SMARTFORM_BACKUP_ROOT_REQUIRED")
    const versions = []
    if (action !== "CREATE" && "expectedFingerprint" in input) {
      const saved = await this.read({
        connectionId: input.connectionId,
        formName: input.formName,
        language: input.language,
        version: "saved"
      })
      if (
        saved.fingerprint !== input.expectedFingerprint ||
        saved.packageName !== input.packageName
      )
        throw new Error("SMARTFORM_PRECHANGE_MISMATCH")
      versions.push(saved)
      if (saved.active) {
        const active = await this.read({
          connectionId: input.connectionId,
          formName: input.formName,
          language: input.language,
          version: "active"
        })
        if (active.fingerprint !== saved.fingerprint) throw new Error("SMARTFORM_PRECHANGE_CHANGED")
        versions.push(active)
      }
    }
    const backupDirectory = join(this.stateRoot, "smartform-backups", input.connectionId)
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 })
    const backupPath = join(
      backupDirectory,
      `${createHash("sha256").update(input.operationId).digest("hex")}.json`
    )
    await writeFile(
      backupPath,
      JSON.stringify(
        {
          observedAt: new Date().toISOString(),
          action,
          formName: input.formName,
          versions,
          requestedChange: input
        },
        null,
        2
      ),
      { flag: "wx", mode: 0o600 }
    )
    const version = action === "ACTIVATE" ? "active" : "saved"
    const request: SmartformRequest = {
      action,
      formName: input.formName,
      language: input.language,
      version,
      packageName: input.packageName,
      ...(input.transportNumber ? { transportNumber: input.transportNumber } : {}),
      ...("xml" in input ? { xml: input.xml } : {}),
      ...("expectedFingerprint" in input ? { expectedFingerprint: input.expectedFingerprint } : {})
    }
    await beforeInvoke?.()
    const response = await this.backend.callSmartform(input.connectionId, request)
    const result = this.checked(input.connectionId, request, response)
    if (
      result.packageName !== input.packageName ||
      (action === "ACTIVATE" ? !result.active || result.inactive : !result.inactive)
    )
      throw new Error("SMARTFORM_WRITE_READBACK_MISMATCH: outcome may be unknown; do not retry")
    return {
      ...result,
      action,
      backupPath,
      readOnly: false,
      automaticRetry: false,
      generatedFunctionExecuted: false
    }
  }

  private checked(
    connectionId: string,
    request: { formName: string; language: string; version: string },
    raw: SmartformResponse
  ) {
    const result = responseSchema.parse(raw)
    if (
      result.formName !== request.formName ||
      result.language !== request.language ||
      result.version !== request.version
    )
      throw new Error("SMARTFORM_RESPONSE_SCOPE_MISMATCH")
    if (result.status !== "S") throw new Error(`SMARTFORM_${result.code}: ${result.message}`)
    if (
      (request.version === "active" && result.active !== "X") ||
      (result.active !== "X" && result.inactive !== "X")
    )
      throw new Error("SMARTFORM_RESPONSE_VERSION_MISMATCH")
    fingerprint.parse(result.fingerprint)
    validateSmartformXml(result.xml)
    return {
      connectionId,
      formName: result.formName,
      language: result.language,
      version: result.version,
      packageName: result.packageName,
      active: result.active === "X",
      inactive: result.inactive === "X",
      fingerprint: result.fingerprint,
      xml: result.xml,
      xmlSha256: createHash("sha256").update(result.xml).digest("hex"),
      requestNumber: result.requestNumber,
      readOnly: true
    }
  }
}
