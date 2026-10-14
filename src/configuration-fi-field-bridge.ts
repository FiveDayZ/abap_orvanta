import { createHash } from "node:crypto"
import { z } from "zod"
import { configurationFiDependencyFields } from "./configuration-fi-dependencies.js"

const scope = {
  connectionId: "w200",
  client: "200",
  booleanClass: "009",
  classType: "B"
} as const
const fieldsSchema = z
  .array(z.object({ table: z.string(), name: z.string() }).strict())
  .min(1)
  .max(configurationFiDependencyFields.length)
const allowedFields = new Set<string>(configurationFiDependencyFields)
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const badiTables = ["BADI_MAIN", "BADI_IMPL", "BADI_SPOT", "BADIISIMPLED"] as const
const code = (suffix: string) => new Error(`FI_FIELD_BRIDGE_${suffix}`)

/** A bounded draft contract, not permission to execute a native function or deploy a helper. */
export function prepareConfigurationFiFieldBridge(
  fields: { table: string; name: string }[],
  booleanClass: string
) {
  if (booleanClass !== scope.booleanClass) throw code("SCOPE_INVALID")
  const parsed = fieldsSchema.safeParse(fields)
  if (!parsed.success) throw code("SCOPE_INVALID")
  const keys = parsed.data.map((field) => `${field.table}-${field.name}`)
  if (new Set(keys).size !== keys.length || keys.some((key) => !allowedFields.has(key)))
    throw code("SCOPE_INVALID")
  const ordered = [...parsed.data].sort((a, b) =>
    `${a.table}-${a.name}`.localeCompare(`${b.table}-${b.name}`)
  )
  return {
    status: "blocked_prerequisites",
    readOnly: true,
    scope: { ...scope },
    fields: ordered,
    requestFingerprint: hash({ ...scope, fields: ordered }),
    candidateFunctionName: null,
    deploymentReady: false,
    nativeExecutionAvailable: false,
    session: {
      isolationRequired: "fresh_internal_session",
      crossCallCursorReuse: false,
      ddicReset: "G_DDIC_INTERFACE_RESET",
      ddicResetDelegate: "GBDD_DDIC_INTERFACE_RESET",
      ddicResetClearsBooleanClassCache: false,
      booleanClassCache: "GBL6 G_GB01_READ/G_CLASS_LST and field descriptions",
      isolationVerified: false
    },
    fieldSwitchReview: {
      badi: "BADI_GBDD_FIELD_SET",
      interface: "IF_EX_BADI_GBDD_FIELD_SET",
      method: "EXCLUDE_FIELD",
      metadataTables: badiTables,
      activeImplementations: "not_observed",
      sideEffects: "not_reviewed"
    },
    responseContract: {
      status: "draft_not_deployed",
      allowedValues: ["T", "F"],
      fieldAttributes: "DFIES",
      outputLength: "OUTPUTLEN",
      eligibilityAndAttributesSeparate: true,
      conversionsPerformed: false
    },
    blockers: [
      "FI_FIELD_BRIDGE_BADI_IMPLEMENTATIONS_UNREVIEWED",
      "FI_FIELD_BRIDGE_FRESH_SESSION_UNVERIFIED",
      "FI_FIELD_BRIDGE_CUSTOMER_RFC_NOT_PREPARED"
    ]
  } as const
}

const integerText = z.string().regex(/^\d{1,6}$/)
const identifier = z.string().regex(/^[A-Z][A-Z0-9_]{0,29}$/)
const optionalIdentifier = z.union([identifier, z.literal("")])
const observedField = z
  .object({
    TABNAME: identifier,
    FIELDNAME: identifier,
    BALLOWED: z.enum(["T", "F"]),
    DFIES: z
      .object({
        TABNAME: identifier,
        FIELDNAME: identifier,
        DATATYPE: z.enum(["CHAR", "QUAN"]),
        INTTYPE: z.enum(["C", "P"]),
        LENG: integerText,
        INTLEN: integerText,
        OUTPUTLEN: integerText,
        DECIMALS: integerText,
        CONVEXIT: z.string().regex(/^$|^[A-Z0-9_]{1,5}$/),
        LOWERCASE: z.enum(["", "X"]),
        REFTABLE: optionalIdentifier,
        REFFIELD: optionalIdentifier
      })
      .strict()
  })
  .strict()

/** Validate imported draft observations without promoting them to attested runtime eligibility. */
export function decodeConfigurationFiFieldBridgeObservation(
  request: ReturnType<typeof prepareConfigurationFiFieldBridge>,
  response: unknown
) {
  const parsedRequest = z
    .object({
      scope: z
        .object({
          connectionId: z.literal(scope.connectionId),
          client: z.literal(scope.client),
          booleanClass: z.literal(scope.booleanClass),
          classType: z.literal(scope.classType)
        })
        .strict(),
      fields: fieldsSchema,
      requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/)
    })
    .safeParse(request)
  if (!parsedRequest.success) throw code("REQUEST_CHANGED")
  const checked = prepareConfigurationFiFieldBridge(
    parsedRequest.data.fields,
    parsedRequest.data.scope.booleanClass
  )
  if (parsedRequest.data.requestFingerprint !== checked.requestFingerprint)
    throw code("REQUEST_CHANGED")
  const parsed = z
    .object({
      connectionId: z.literal(scope.connectionId),
      client: z.literal(scope.client),
      booleanClass: z.literal(scope.booleanClass),
      classType: z.literal(scope.classType),
      requestFingerprint: z.literal(checked.requestFingerprint),
      fields: z.array(observedField).min(1).max(configurationFiDependencyFields.length)
    })
    .strict()
    .safeParse(response)
  if (!parsed.success) throw code("RESPONSE_INVALID")
  const keys = parsed.data.fields.map((field) => `${field.TABNAME}-${field.FIELDNAME}`)
  if (
    new Set(keys).size !== keys.length ||
    hash([...keys].sort()) !==
      hash(checked.fields.map((field) => `${field.table}-${field.name}`).sort())
  )
    throw code("FIELD_SET_CHANGED")
  for (const field of parsed.data.fields) {
    const attrs = field.DFIES
    if (
      attrs.TABNAME !== field.TABNAME ||
      attrs.FIELDNAME !== field.FIELDNAME ||
      Number(attrs.LENG) < 1 ||
      Number(attrs.INTLEN) < 1 ||
      Number(attrs.OUTPUTLEN) < 1 ||
      Number(attrs.DECIMALS) > Number(attrs.LENG) ||
      (attrs.DATATYPE === "CHAR" ? attrs.INTTYPE !== "C" : attrs.INTTYPE !== "P") ||
      (attrs.DATATYPE === "CHAR" && attrs.DECIMALS.replaceAll("0", "") !== "")
    )
      throw code("ATTRIBUTES_INVALID")
  }
  return {
    status: "draft_observation_unverified",
    fields: parsed.data.fields,
    requestFingerprint: checked.requestFingerprint,
    nativeEligibility: "not_attested",
    runtimeVerified: false,
    saveAvailable: false,
    conversionsPerformed: false
  } as const
}
