import type { AdtHTTP, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js"
import { encodeEntity, parse } from "abap-adt-api/build/utilities.js"
import { XMLValidator } from "fast-xml-parser"
import { z } from "zod"
import type { LegacyUsageReferences, UsageReferenceInfo } from "./backend.js"

const base = "/sap/bc/adt/repository/informationsystem/"
export const legacyWhereUsedPaths = [
  `${base}whereused`,
  `${base}fullnamemapping`,
  `${base}metadata`
] as const

/**
 * The declaration positions the legacy RIS route can map.
 *
 * This route is reached only when the modern `usageReferences` endpoint is absent, which is the
 * case on ECC 7.31, and its first call (`MAP_URI_TO_RIS_REQUEST`) needs a source position that
 * really is the object's declaration. Only function modules were accepted at first, so a class
 * query failed with "supports only an exact function declaration position" - a message from this
 * file, not from SAP, which was never asked (live w200, 2026-09-25T14:51). The families below are
 * the same individual source targets `sourceUri` already accepts, so a caller that can name the
 * object can also ask for its references.
 */
const declarationFamilies: readonly { path: RegExp; declaration: RegExp }[] = [
  {
    path: /^\/sap\/bc\/adt\/functions\/groups\/[^/]+\/fmodules\/([a-z0-9_]+)\/source\/main$/i,
    declaration: /^\s*FUNCTION\s+([a-z0-9_]+)\s*(?:\.|$)/i
  },
  {
    // `DEFINITION DEFERRED` declares nothing usable, so it is not a target position.
    path: /^\/sap\/bc\/adt\/oo\/classes\/([a-z0-9_]+)(?:\/source\/main|\/includes\/[^/]+)?$/i,
    declaration: /^\s*CLASS\s+([a-z0-9_]+)\s+DEFINITION\b(?!\s+DEFERRED\b)/i
  },
  {
    path: /^\/sap\/bc\/adt\/oo\/interfaces\/([a-z0-9_]+)(?:\/source\/main)?$/i,
    declaration: /^\s*INTERFACE\s+([a-z0-9_]+)\b(?!\s+DEFERRED\b)/i
  },
  {
    path: /^\/sap\/bc\/adt\/programs\/programs\/([a-z0-9_]+)(?:\/source\/main)?$/i,
    declaration: /^\s*(?:REPORT|PROGRAM)\s+([a-z0-9_]+)\s*(?:\.|$)/i
  }
]

const objectType = z.object({
  trobjtype: z.string().max(4),
  subtype: z.string().max(4),
  legacy_type: z.string().max(4)
})
const mappingSchema = objectType.extend({
  object_name: z.string().min(1).max(120),
  encl_object_name: z.string().max(120),
  scope_trobjtype: z.string(),
  scope_subtype: z.string(),
  scope_legacy_type: z.string(),
  scope_object_name: z.string(),
  scope_encl_object_name: z.string(),
  full_name: z.string().min(1).max(1024),
  suppress_selection_dialog: z.literal("X")
})
type ObjectType = z.infer<typeof objectType>
type Mapping = z.infer<typeof mappingSchema>

function invalid(reason: string): never {
  throw new Error(`Legacy where-used parser-or-content-type: ${reason}`)
}

function xmlRoot(response: HttpClientResponse, name: string): unknown {
  const media = String(
    Object.entries(response.headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] ??
      ""
  )
    .split(";")[0]!
    .trim()
    .toLowerCase()
  if (response.status < 200 || response.status >= 300)
    throw Object.assign(new Error(`Legacy where-used status code ${response.status}`), {
      status: response.status
    })
  if (media !== "application/xml" && media !== "text/xml" && !media.endsWith("+xml"))
    invalid("expected XML")
  const body = response.body.trim()
  if (
    !body ||
    body.length > 8 * 1024 * 1024 ||
    /<!DOCTYPE|<!ENTITY/i.test(body) ||
    XMLValidator.validate(body) !== true
  )
    invalid("empty, oversized or unexpected XML envelope")
  let document: Record<string, unknown>
  try {
    document = parse(body, { parseTagValue: false, trimValues: true })
  } catch {
    return invalid("malformed XML")
  }
  const roots = Object.keys(document).filter((key) => !key.startsWith("?"))
  if (roots.length !== 1 || roots[0] !== name) invalid("unexpected root")
  return document[name]
}

function rows(root: unknown, child: string): unknown[] {
  if (root === "") return []
  if (!root || typeof root !== "object" || Array.isArray(root)) return invalid("invalid list")
  const values = root as Record<string, unknown>
  if (Object.keys(values).some((key) => key !== child)) invalid("unexpected list member")
  const value = values[child]
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

// The legacy content handler additionally escapes angle brackets as percent sequences.
const xmlValue = (value: string) =>
  encodeEntity(value.replaceAll("<", "%3C").replaceAll(">", "%3E"))
const decodeValue = (value: string) => value.replaceAll("%3C", "<").replaceAll("%3E", ">")
const field = (name: string, value: string) => `<${name}>${xmlValue(value)}</${name}>`
const typeXml = (type: ObjectType) =>
  field("trobjtype", type.trobjtype) +
  field("subtype", type.subtype) +
  field("legacy_type", type.legacy_type)

function requestXml(mapping: Mapping, resultType: ObjectType) {
  return (
    `<ris_request><object_type>${typeXml(resultType)}</object_type><scope_object>` +
    typeXml({ trobjtype: "", subtype: "", legacy_type: "" }) +
    field("object_name", "") +
    field("encl_object_name", "") +
    `</scope_object><payload>${typeXml(mapping)}` +
    field("object_name", mapping.object_name) +
    field("encl_object_name", mapping.encl_object_name) +
    field("full_name", mapping.full_name) +
    "</payload></ris_request>"
  )
}

export function parseLegacyReferences(response: HttpClientResponse): UsageReferenceInfo[] {
  return rows(xmlRoot(response, "ris_generic_results"), "ris_generic_result").map((value) => {
    const parsed = z
      .object({
        object_name: z.string().min(1).max(120),
        enclosing_object_name: z.string().max(120),
        description: z.string().max(4000),
        uri: z.string().min(1).max(2048)
      })
      .safeParse(value)
    if (!parsed.success) return invalid("invalid reference fields")
    const item = parsed.data
    const uri = item.uri
    if (
      !uri.startsWith("/sap/bc/adt/") ||
      /[%\\\s]/.test(uri) ||
      new URL(uri, "https://sap.invalid").pathname !== uri.split(/[?#]/)[0]
    )
      invalid("invalid reference URI")
    return {
      uri,
      objectIdentifier: uri,
      identifierKind: "ADT_RIS_URI",
      name: decodeValue(item.object_name),
      enclosingObjectName: decodeValue(item.enclosing_object_name),
      description: decodeValue(item.description)
    }
  })
}

export async function legacyWhereUsed(
  http: Pick<AdtHTTP, "request">,
  uri: string,
  line: number,
  character: number,
  source: string
): Promise<LegacyUsageReferences> {
  const sourceLine = source.split(/\r?\n/)[line - 1] ?? ""
  const family = declarationFamilies.find((candidate) => candidate.path.test(uri))
  const name = family ? uri.match(family.path)?.[1]?.toUpperCase() : undefined
  const declaration = family ? sourceLine.match(family.declaration) : null
  if (
    !name ||
    declaration?.[1]?.toUpperCase() !== name ||
    character !== sourceLine.toUpperCase().indexOf(name)
  )
    throw new Error(
      "Legacy where-used supports only the exact declaration position of the named object " +
        `(function module, class, interface or program); ${uri} line ${line} character ${character} ` +
        "is not one."
    )

  const post = (path: string, action: string, body: string, contentType = "application/xml") =>
    http.request(path, {
      method: "POST",
      qs: {
        RIS_REQUEST_TYPE: action,
        ...(action === "MAP_URI_TO_RIS_REQUEST" ? { uri: `${uri}#start=${line},${character}` } : {})
      },
      headers: { Accept: "application/xml", "Content-Type": contentType },
      body
    })
  const mapped = mappingSchema.safeParse(
    xmlRoot(
      await post(legacyWhereUsedPaths[1], "MAP_URI_TO_RIS_REQUEST", source, "text/plain"),
      "ris_data_request"
    )
  )
  if (!mapped.success) invalid("source position mapping is incomplete; no object-level fallback")
  const mapping = mapped.data
  const scope = [
    mapping.scope_trobjtype,
    mapping.scope_subtype,
    mapping.scope_legacy_type,
    mapping.scope_object_name,
    mapping.scope_encl_object_name
  ]
    .filter(Boolean)
    .join(" ")
  if (
    mapping.object_name.toUpperCase() !== name ||
    (!mapping.trobjtype && !mapping.legacy_type) ||
    scope
  )
    // Name what SAP mapped, so a family this route cannot express is diagnosable instead of
    // looking like a generic parse failure.
    invalid(
      `mapping identity or scope is unsupported for ${name}: mapped object ` +
        `${mapping.object_name || "(none)"}, type ${mapping.trobjtype || "-"}/` +
        `${mapping.subtype || "-"}/${mapping.legacy_type || "-"}, scope ${scope || "(none)"}`
    )
  const types = rows(
    xmlRoot(
      await post(legacyWhereUsedPaths[2], "WUL_TYPES_COMPLETE", requestXml(mapping, mapping)),
      "ris_meta_object_types"
    ),
    "ris_meta_object_type"
  ).map((value) => {
    const parsed = objectType.safeParse(value)
    if (!parsed.success || (!parsed.data.trobjtype && !parsed.data.legacy_type))
      return invalid("invalid relationship type")
    return parsed.data
  })
  // The SAP metadata service suppresses some exceptions into an empty table.
  if (!types.length || types.length > 32) invalid("relationship discovery is inconclusive")
  const uniqueTypes = [...new Map(types.map((type) => [JSON.stringify(type), type])).values()]
  const references: UsageReferenceInfo[] = []
  const unverified: Array<{ trobjtype: string; subtype: string; legacy_type: string }> = []
  for (const type of uniqueTypes) {
    const result = await post(legacyWhereUsedPaths[0], "WHERE_USED", requestXml(mapping, type))
    // A result set the handler considers empty comes back as a 200 with no body at all (observed on
    // w200 for a class declaration position, 2026-09-25T14:5x), while a genuinely empty result can
    // also arrive as `<ris_generic_results/>`. An empty body therefore proves nothing in either
    // direction: it is recorded as an unverified type and the remaining types are still queried,
    // instead of aborting the whole analysis or being folded into "no references".
    if (result.status >= 200 && result.status < 300 && result.body.trim() === "") {
      unverified.push(type)
      continue
    }
    references.push(...parseLegacyReferences(result))
    if (references.length > 10000) invalid("reference safety limit reached")
  }
  return {
    engine: "ADT_RIS_WHEREUSED",
    references: [
      ...new Map(
        references.map((item) => [
          JSON.stringify([item.uri, item.name, item.enclosingObjectName]),
          item
        ])
      ).values()
    ],
    relationshipTypes: uniqueTypes,
    ...(unverified.length ? { unverifiedRelationshipTypes: unverified } : {})
  }
}
