import { createHash } from "node:crypto"
import { z } from "zod"
import { assertTableAllowed, TABLE_TIERS } from "./table-allowlist.js"
import { configurationImgDetailLanguage } from "./configuration-img-details.js"
import { configurationUnitFields, configurationUnitLayouts } from "./configuration-unit.js"
import type { findConfigurationActivities } from "./configuration-img.js"

const identifier = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]{0,29}$/)
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)
export const configurationObjectSchema = z
  .object({
    connectionId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,100}$/)
      .transform((v) => v.toLowerCase()),
    objectName: identifier,
    expectedDefinitionFingerprint: fingerprint.optional()
  })
  .strict()

export const configurationDescriptorSchema = configurationObjectSchema.extend({
  includeImg: z.boolean().default(false),
  includeMaintenanceBoundary: z.boolean().optional(),
  includeTextMaintenanceBoundary: z.boolean().optional(),
  includeApiMaintenanceBoundary: z.boolean().optional(),
  language: configurationImgDetailLanguage.optional()
})

// Active w200/200 sources: the dialog SAVE path, not an executable API approval.
export const configurationUnitMaintenanceSources = {
  SAPMUNIT: {
    sourceUri: "/sap/bc/adt/programs/programs/sapmunit/source/main",
    sourceFingerprint: "750fcdce28c18fb76f2ae39a716dddbd882ccb19c15d5566bc683e8c0999a029",
    lineCount: 37
  },
  MUNITTOP: {
    sourceUri: "/sap/bc/adt/programs/includes/munittop/source/main",
    sourceFingerprint: "d37d733a26bb8e152f67d946ec1637dcfd4265bf02877351fd900ee099cdddfe",
    lineCount: 199
  },
  MUNITI01: {
    sourceUri: "/sap/bc/adt/programs/includes/muniti01/source/main",
    sourceFingerprint: "d557000d6e9b110dc1d11de68067710762f364975349d99dce0ef07e9e457093",
    lineCount: 1141
  },
  MUNITF01: {
    sourceUri: "/sap/bc/adt/programs/includes/munitf01/source/main",
    sourceFingerprint: "c77ea8dc1adc6c4ee882d348baa3348ae80d6bfe083b8e9ecdfeb0b18b14b421",
    lineCount: 1679
  },
  MUNITF03: {
    sourceUri: "/sap/bc/adt/programs/includes/munitf03/source/main",
    sourceFingerprint: "392e2a6ca2eb60bd4dd15c44edcf4cd031670f7dffe6131bb76822803330d6f7",
    lineCount: 312
  }
} as const

export const configurationUnitTextMaintenanceIncludes = {
  MUNITF02: {
    sourceUri: "/sap/bc/adt/programs/includes/munitf02/source/main",
    sourceFingerprint: "fe465a082ae7ed03d30e41a8deed6ca837f71ddb17076aeae2f9f56f6ac95036",
    lineCount: 135
  }
} as const

export const configurationUnitTextMaintenanceFunctions = {
  UNITS_TRANSLATION_1: {
    sourceFingerprint: "b667eb3d89a9d874bb6659adcdfd76db544adc26c33329cb24fffdf27a0a593e",
    interfaceFingerprint: "47093af815af55d409b00764c25bc1b9c644b685422737e74ea91b86e9cf0882",
    remoteEnabled: false,
    updateTask: false,
    updateTaskMode: "",
    lineCount: 72
  },
  LXE_TRANSLATE_TEXT_WB: {
    sourceFingerprint: "d468788109fe08c9c209007a91af21c5884a3ec520926fab14585318a6acde86",
    interfaceFingerprint: "2eac3aba475affbb6bb1dff5a35c0e7ddfc97d2f1bfc8dc81bb91ae64dcec9a6",
    remoteEnabled: false,
    updateTask: false,
    updateTaskMode: "",
    lineCount: 25
  },
  UPDATE_T006A: {
    sourceFingerprint: "b0b061b0ab46cc8b190e9ee33b5ef1e999955339a3776a8bbb9e49c6a741b1ac",
    interfaceFingerprint: "69ecde3d00ae343c5d84e09c0ba5f357e5890aced1840a525a0cdc87753f172b",
    remoteEnabled: false,
    updateTask: true,
    updateTaskMode: "1",
    lineCount: 17
  },
  INSERT_T006A: {
    sourceFingerprint: "c2127dc7ec1b4d4a537cd56e43da7369d0c472a8d4dcbbe2d086fb26babc6211",
    interfaceFingerprint: "69ecde3d00ae343c5d84e09c0ba5f357e5890aced1840a525a0cdc87753f172b",
    remoteEnabled: false,
    updateTask: true,
    updateTaskMode: "1",
    lineCount: 16
  },
  TR_OBJECT_INSERT: {
    sourceFingerprint: "f8723f9e46418dfe7470efdcfc953f97213714b73a9b9892ba00f76ee0638108",
    interfaceFingerprint: "9770a4189d0f9d226329120d41e117f94834d9b341ec5a710f5e281cc5c739f5",
    remoteEnabled: false,
    updateTask: false,
    updateTaskMode: "",
    lineCount: 80
  },
  TRINT_CALL_AFTER_IMP_METHOD: {
    sourceFingerprint: "1c8a2950f63c740eef42d8e2ca09d71bd8ea7cb4527f09473bd5b4ce05d38f89",
    interfaceFingerprint: "487d0c30d30179faa2db1bd92b5a0910eb5f6630cb569eb8af2f2cdc0a459c10",
    remoteEnabled: false,
    updateTask: false,
    updateTaskMode: "",
    lineCount: 116
  }
} as const

// API candidates observed on w200/200; pins attest definitions, never execution safety.
export const configurationUnitApiMaintenanceFunctions = {
  ENQUEUE_E_TABLE: {
    sourceFingerprint: "78f1c959b16c20315776e17aa622cadd47cebc9ac93d93712d90cf1e7a808517",
    interfaceFingerprint: "76bd7c20e487f96d8b3ddc97861863ec4cff89d90848867c9c76f3d82861aec7",
    remoteEnabled: false,
    updateTask: false,
    updateTaskMode: "",
    lineCount: 66
  },
  DEQUEUE_E_TABLE: {
    sourceFingerprint: "319f85fac630b1390e72f77f44c49e77c65fcecd18dddf9a7badfbcdadf409c8",
    interfaceFingerprint: "281a0dc40c8b9a57adcbd52d777ec53475724280aa9d5f574419e58199c5ea5b",
    remoteEnabled: false,
    updateTask: false,
    updateTaskMode: "",
    lineCount: 63
  },
  TRINT_OBJECTS_CHECK_AND_INSERT: {
    sourceFingerprint: "f161a219078af55400247d8f9ebea5ed69983f75b2d98880aa49a7c39b5bda29",
    interfaceFingerprint: "fcd4495ffe804e365b023af13d195c6e643aaf539e064757fdc6cd9b87853566",
    remoteEnabled: false,
    updateTask: false,
    updateTaskMode: "",
    lineCount: 5340
  },
  TR_APPEND_TO_COMM_OBJS_KEYS: {
    sourceFingerprint: "54cd7acd7852d1b719b6d234d0c0d427ca0087178e4cb376c02a49c2c7687a79",
    interfaceFingerprint: "c8141af2fe9972c05237bc830894223510aabb1280f6924542bfcd37673880f4",
    remoteEnabled: false,
    updateTask: false,
    updateTaskMode: "",
    lineCount: 223
  },
  TRINT_APPEND_TO_COMM_ARRAYS: {
    sourceFingerprint: "34a6d758f83c9460821ff95a74e9565bd89b4d6b548c7ea5a9d522fbd49a7611",
    interfaceFingerprint: "c834dc05f0a221e952fc3dec5c524c3c1b82186826a67b93819d40909f5f9fe7",
    remoteEnabled: false,
    updateTask: false,
    updateTaskMode: "",
    lineCount: 763
  }
} as const

async function inspectUnitMaintenanceRoute(
  img: Awaited<ReturnType<typeof findConfigurationActivities>>,
  readImg: () => Promise<Awaited<ReturnType<typeof findConfigurationActivities>>>,
  readSource?: (name: string) => Promise<unknown>,
  includeText = false,
  readFunction?: (name: string) => Promise<unknown>,
  includeApi = false
) {
  const mapping = (value: typeof img) => ({
    connectionId: value.connectionId,
    objectName: value.objectName,
    definitionFingerprint: value.definitionFingerprint,
    readOnly: value.readOnly,
    saveAvailable: value.saveAvailable,
    truncated: value.truncated,
    mappingStatus: value.maintenanceMapping.status,
    mappingFingerprint:
      "fingerprint" in value.maintenanceMapping ? value.maintenanceMapping.fingerprint : null,
    objects: value.maintenanceObjects,
    activities: value.activities.map(({ activityId, maintenanceObjects, headerTransaction }) => ({
      activityId,
      maintenanceObjects,
      headerTransaction
    })),
    lookups: value.lookups.map(({ objectName, objectType, status, method, transaction }) => ({
      objectName,
      objectType,
      status,
      method,
      transaction
    }))
  })
  const initial = mapping(img)
  const activity = img.activities.find((v) => v.activityId === "SIMG_CFMENUOLMSOMSC")
  const registered = img.maintenanceObjects.filter(
    (v) =>
      v.objectName === "CUNI" &&
      v.objectType === "T" &&
      v.registration &&
      "TABNAME" in v.registration &&
      v.registration.TABNAME === img.objectName
  )
  const lookup = img.lookups.filter(
    (v) =>
      v.objectName === "CUNI" &&
      v.objectType === "T" &&
      v.status === "read" &&
      v.method === "transaction_metadata_join" &&
      v.transaction?.TCODE === "CUNI" &&
      v.transaction?.PGMNA === "SAPMUNIT"
  )
  let status = "source_attested",
    failedSource: string | null = null,
    reads = 0,
    mappingReads = 1
  if (
    img.truncated ||
    img.maintenanceMapping.status !== "read" ||
    registered.length !== 1 ||
    lookup.length !== 1 ||
    !activity?.maintenanceObjects.includes("T:CUNI")
  )
    status = "mapping_unresolved"
  else if (!readSource || (includeText && !readFunction)) status = "unavailable"
  let failedFunction: string | null = null,
    functionReads = 0
  const functions: {
    functionName: string
    sourceFingerprint: string
    interfaceFingerprint: string
    remoteEnabled: boolean
    updateTask: boolean
    updateTaskMode: string
    lineCount: number
  }[] = []
  const sourcePins = includeText
    ? { ...configurationUnitMaintenanceSources, ...configurationUnitTextMaintenanceIncludes }
    : configurationUnitMaintenanceSources
  const functionPins = includeApi
    ? { ...configurationUnitTextMaintenanceFunctions, ...configurationUnitApiMaintenanceFunctions }
    : configurationUnitTextMaintenanceFunctions
  const sources: {
    objectName: string
    sourceUri: string
    sourceFingerprint: string
    lineCount: number
  }[] = []
  if (status === "source_attested") {
    for (const pass of [0, 1]) {
      for (const [objectName, pin] of Object.entries(sourcePins)) {
        try {
          reads++
          if (
            !z
              .object({
                connectionId: z.literal("w200"),
                objectName: z.literal(objectName),
                sourceUri: z.literal(pin.sourceUri),
                sourceFingerprint: z.literal(pin.sourceFingerprint),
                lineCount: z.literal(pin.lineCount)
              })
              .safeParse(await readSource!(objectName)).success
          ) {
            status = pass === 0 ? "unreviewed" : "changed"
            failedSource = objectName
            break
          }
          if (pass === 0) sources.push({ objectName, ...pin })
        } catch {
          status = "unavailable"
          failedSource = objectName
          break
        }
      }
      if (status !== "source_attested") break
      if (includeText) {
        for (const [functionName, pin] of Object.entries(functionPins)) {
          try {
            functionReads++
            if (
              !z
                .object({
                  connectionId: z.literal("w200"),
                  functionName: z.literal(functionName),
                  sourceFingerprint: z.literal(pin.sourceFingerprint),
                  interfaceFingerprint: z.literal(pin.interfaceFingerprint),
                  remoteEnabled: z.literal(pin.remoteEnabled),
                  updateTask: z.literal(pin.updateTask),
                  updateTaskMode: z.literal(pin.updateTaskMode),
                  source: z.array(z.string()).length(pin.lineCount)
                })
                .safeParse(await readFunction!(functionName)).success
            ) {
              status = pass === 0 ? "unreviewed" : "changed"
              failedFunction = functionName
              break
            }
            if (pass === 0) functions.push({ functionName, ...pin })
          } catch {
            status = "unavailable"
            failedFunction = functionName
            break
          }
        }
      }
      if (status !== "source_attested") break
    }
    if (status === "source_attested") {
      try {
        mappingReads++
        if (JSON.stringify(mapping(await readImg())) !== JSON.stringify(initial)) status = "changed"
      } catch {
        status = "unavailable"
      }
    }
  }
  const attested = status === "source_attested"
  return {
    status,
    failedSource,
    ...(includeApi
      ? {
          apiMaintenanceBoundary: attested
            ? {
                executionMode: "api_only",
                status: "customer_adapter_required",
                objectName: "T006A",
                operation: "update_existing_text",
                keyFields: ["MANDT", "SPRAS", "MSEHI"],
                patchFields: ["MSEHT", "MSEHL"],
                functions: functions.filter(
                  (f) => f.functionName in configurationUnitApiMaintenanceFunctions
                ),
                observations: [
                  {
                    functionName: "TRINT_OBJECTS_CHECK_AND_INSERT",
                    lines: [314, 323, 330, 338, 343, 4670, 4737, 4779, 5036, 5043],
                    finding:
                      "API insert mode asserts a specific parameter combination. NO_DBCOMMIT controls DB_COMMIT only; request/task creation can commit anyway. The API selects a task and may create it, so a fixed parent request does not attest an approved exact task or an atomic LUW."
                  },
                  {
                    functionName: "TR_APPEND_TO_COMM_OBJS_KEYS",
                    lines: [127, 146, 160, 163, 170, 191, 195],
                    finding:
                      "Checks CTS authority, locks the task and filters language keys. Delegates without overriding TRINT_APPEND_TO_COMM_ARRAYS IV_DIALOG default X; invokes a customizing synchronizer after successful append. This entry does not prove a no-dialog route or exact language-key retention."
                  },
                  {
                    functionName: "TRINT_APPEND_TO_COMM_ARRAYS",
                    lines: [16, 211, 213, 657, 671, 704, 762],
                    finding:
                      "IV_DIALOG defaults to X; direct insertion delegates to routines and has rollback paths. Disabling dialog alone does not establish higher-level authorization, original-language filtering, commit ownership or successful exact-row recording."
                  },
                  {
                    functionName: "ENQUEUE_E_TABLE",
                    lines: [8, 11, 30, 62],
                    finding:
                      "Generated generic table lock; the caller chooses table, key and scope. Its existence does not prove compatibility with every CUNI/translation writer or protection across CTS commits."
                  }
                ],
                requirements: [
                  "CUSTOMER_API_EXACT_OBJECT_APPROVAL_AND_DEPLOYMENT",
                  "SAP_SIDE_AUTHORIZATION_AND_CLIENT_POLICY",
                  "STANDARD_WRITER_COMPATIBLE_ENQUEUE_AND_LOCKED_FULL_ROW_VERSION",
                  "PRESERVE_OMITTED_TEXTS_EXTERNAL_ALIASES_AND_OTHER_ROWS",
                  "EXISTING_APPROVED_REQUEST_AND_EXACT_TASK_NO_IMPLICIT_CREATION",
                  "OFFICIAL_TYPED_CTS_KEY_AND_LANGUAGE_RECORDING",
                  "EXPLICIT_COMMIT_UPDATE_TASK_FAILURE_AND_PARTIAL_OUTCOME_CONTRACT",
                  "DURABLE_OPERATION_ID_RECONCILIATION_BEFORE_RETRY"
                ],
                executable: false,
                guiAutomationAllowed: false,
                directSqlAllowed: false,
                headlessRouteProved: false,
                atomicRollbackProved: false,
                runtimeExecuted: false
              }
            : null
        }
      : {}),
    ...(includeText
      ? {
          failedFunction,
          textMaintenanceBoundary: attested
            ? {
                objectName: "T006A",
                keyFields: ["MANDT", "SPRAS", "MSEHI"],
                patchFields: ["MSEHT", "MSEHL"],
                functions,
                translation: {
                  entry: "UNITS_TRANSLATION_1",
                  delegate: "LXE_TRANSLATE_TEXT_WB",
                  screen: "1000",
                  acceptsExactRowKey: false,
                  acceptsTextPatch: false
                },
                persistence: {
                  update: "UPDATE_T006A",
                  insert: "INSERT_T006A",
                  input: "full_T006A_rows",
                  callerUsesUpdateTask: true,
                  updateFailure: "MESSAGE_A003",
                  insertDuplicates: "accepting_duplicate_keys",
                  directCallsAuthorized: false
                },
                cts: {
                  entry: "TR_OBJECT_INSERT",
                  delegate: "TRINT_OBJECTS_CHECK_AND_INSERT",
                  withDialog: "X",
                  sendMessage: "X",
                  keyEncodingVerified: false
                },
                afterImport: {
                  entry: "TRINT_CALL_AFTER_IMP_METHOD",
                  methodDiscovery: "CTO_ORDER_GET_METHOD_CALLS",
                  dynamicMethodExecutionResolved: false,
                  noCommitPropagationProved: false
                },
                observations: [
                  {
                    objectName: "MUNITF02",
                    lines: [12, 20, 34, 38],
                    finding:
                      "Translation asks for source/target language and calls UNITS_TRANSLATION_1; not a one-row text patch route."
                  },
                  {
                    functionName: "UNITS_TRANSLATION_1",
                    lines: [39, 41, 45, 48, 64, 67],
                    finding:
                      "Constructs R3TR/TABU/table transport key and delegates to LXE_TRANSLATE_TEXT_WB without TABLEKEY. No exact unit key or MSEHT/MSEHL patch parameter; errors may raise dialog messages."
                  },
                  {
                    functionName: "LXE_TRANSLATE_TEXT_WB",
                    lines: [20, 21, 22, 23, 24],
                    finding:
                      "Sets function-group source/target language and key globals and calls screen 1000; not a headless maintenance API."
                  },
                  {
                    functionName: "UPDATE_T006A",
                    lines: [6, 10, 12, 13],
                    finding:
                      "Accepts whole T006A table rows, performs UPDATE FROM TABLE and MESSAGE A003 on failure. No field patch, expected version, enqueue or authorization check is implemented here."
                  },
                  {
                    functionName: "INSERT_T006A",
                    lines: [10, 13],
                    finding:
                      "Inserts full rows with ACCEPTING DUPLICATE KEYS, no one-row update contract; cannot be used to recover a missing language text automatically."
                  },
                  {
                    functionName: "TR_OBJECT_INSERT",
                    lines: [40, 43, 44],
                    finding:
                      "Hard-codes iv_with_dialog and iv_send_message to X in downstream CTS insertion; iv_no_show_option does not prove no-dialog or atomic key recording."
                  },
                  {
                    functionName: "TRINT_CALL_AFTER_IMP_METHOD",
                    lines: [56, 69, 73, 95, 97, 114],
                    finding:
                      "Discovers transport after-import methods, sorts them and forwards NO_COMMIT to call_imp_methods; actual dynamic methods and write_log remain unreviewed."
                  }
                ],
                executable: false,
                wholeRowVersionAvailable: false,
                headlessRouteProved: false,
                atomicRollbackProved: false,
                refusalReasons: [
                  "TRANSLATION_OPENS_SCREEN",
                  "FULL_ROW_WRITERS_ARE_NOT_TEXT_PATCH_API",
                  "CTS_INSERT_FORCES_DIALOG",
                  "DYNAMIC_AFTER_IMPORT_METHODS_UNREVIEWED"
                ]
              }
            : null
        }
      : {}),
    readOnly: true,
    executable: false,
    route: attested
      ? {
          activityId: activity!.activityId,
          headerTransaction: activity!.headerTransaction,
          objectName: "CUNI",
          objectType: "T",
          transaction: "CUNI",
          program: "SAPMUNIT",
          kind: "dialog_module_pool"
        }
      : null,
    mappingFingerprint: attested
      ? createHash("sha256").update(JSON.stringify(initial)).digest("hex")
      : null,
    sources: attested ? sources : null,
    sourceFingerprint: attested
      ? createHash("sha256")
          .update(JSON.stringify(includeText ? { sources, functions } : sources))
          .digest("hex")
      : null,
    observations: attested
      ? [
          {
            objectName: "MUNITI01",
            lines: [205, 208, 210, 352, 353],
            finding:
              "SAVE dispatches through dialog global action to save_data or save_transport; not a headless interface."
          },
          {
            objectName: "MUNITF01",
            lines: [166, 224, 323, 346, 399, 444, 499, 525, 644, 727, 771, 788],
            finding:
              "save_data uses global flag/data/language state; registers insert/update/delete update tasks for unit tables, also handles T006D/T006B/T006C and conditional IS-Oil tables. Recording-enabled branch delegates tr_object_insert; otherwise COMMIT WORK. Returned status alone does not prove update-task success."
          },
          {
            objectName: "MUNITF03",
            lines: [12, 17, 24, 44, 54, 107, 123, 126, 138, 142, 159, 161],
            finding:
              "CUNI uses R3TR/TDAT, reads client recording settings and ALE edit checks. E071K rows use TABU with master TDAT/CUNI and supplied table keys. tr_object_insert rolls back on error or commits on success; no generic key codec or atomic CTS guarantee is established."
          },
          {
            objectName: "MUNITF01",
            lines: [1417, 1429, 1496, 1509],
            finding:
              "Dialog mode switches check S_TABU_DIS and enqueue E_TABLE. Current-user permissions, exact lock coverage and release behavior were not executed."
          }
        ]
      : null,
    coverage: {
      completeCallChain: false,
      headlessRouteProved: false,
      atomicRollbackProved: false,
      ctsKeyEncodingVerified: false,
      currentUserAuthorization: "not_checked",
      targetClientSettings: "not_checked",
      runtimeExecuted: false,
      bcSetRouteBound: false
    },
    refusalReasons: attested
      ? [
          "DIALOG_GLOBAL_STATE_REQUIRED",
          "UPDATE_TASK_AND_COMMIT_OWNERSHIP_UNVERIFIED",
          "CTS_KEY_RECORDING_NOT_VERIFIED",
          "BCSET_ROUTE_NOT_BOUND_TO_UNIT_OBJECT"
        ]
      : ["MAINTENANCE_ROUTE_NOT_ATTESTED", "MAINTENANCE_API_NOT_VERIFIED"],
    evidence: {
      sourcesRechecked: attested,
      mappingRechecked: attested,
      sourceReaderInvocations: reads,
      sourceReaderInvocationLimit: 2 * Object.keys(sourcePins).length,
      ...(includeText
        ? {
            functionReaderInvocations: functionReads,
            functionReaderInvocationLimit: 2 * Object.keys(functionPins).length
          }
        : {}),
      imgReaderInvocations: mappingReads,
      imgReaderInvocationLimit: 2,
      snapshot: false
    },
    warning: includeText
      ? "Named source and metadata binding only. Translation/CTS dialog entry and full-row update sources are observed, not executed or authorized; downstream screens, CTS routines, update-task completion, add-ons and dynamic after-import methods remain unreviewed."
      : "Named source and metadata binding only; separate from BC Set activation/import evidence. Other includes, translation APIs, add-ons and generated view events remain unreviewed. No maintenance, enqueue, commit, CTS or update function is executed."
  }
}

const objectEvidence = z.object({
  connectionId: z.string(),
  objectKind: z.string(),
  objectName: identifier,
  version: z.string().min(1),
  fingerprint,
  status: z.string().optional(),
  active: z.boolean().optional()
})
const tableEvidence = objectEvidence.extend({
  objectKind: z.literal("transparentTable"),
  packageName: z.string(),
  definition: z.object({
    tableClass: z.literal("TRANSP"),
    description: z.string(),
    deliveryClass: z.string(),
    dataBrowserMaintenance: z.enum(["allowed", "restricted", "notAllowed"]),
    fields: z
      .array(
        z.object({
          name: identifier,
          position: z.number().int().positive(),
          key: z.boolean(),
          dataElement: z.string(),
          description: z.string(),
          referenceTable: z.string().optional(),
          referenceField: z.string().optional()
        })
      )
      .min(1)
      .max(64)
  })
})
const metadataEvidence = z.object({
  connectionId: z.string(),
  tableName: z.literal("DD03L"),
  status: z.literal("ok"),
  readOnly: z.literal(true),
  truncated: z.literal(false),
  returnedCount: z.number().int(),
  data: z
    .array(
      z
        .object({
          TABNAME: identifier,
          AS4LOCAL: z.literal("A"),
          FIELDNAME: identifier,
          DATATYPE: z.string().min(1),
          LENG: z.string().regex(/^\d{1,6}$/),
          DECIMALS: z.string().regex(/^\d{1,6}$/)
        })
        .strict()
    )
    .min(1)
    .max(64)
})
const elementEvidence = objectEvidence.extend({
  objectKind: z.literal("dataElement"),
  definition: z.object({ domainName: z.string() })
})
const domainEvidence = objectEvidence.extend({
  objectKind: z.literal("domain"),
  definition: z.object({
    dataType: z.string().min(1),
    length: z.number().int().positive(),
    decimals: z.number().int().nonnegative(),
    lowercase: z.boolean(),
    conversionExit: z.string(),
    valueTable: z.string(),
    fixedValues: z
      .array(z.object({ low: z.string(), high: z.string(), description: z.string() }))
      .max(500)
  })
})

function assertEvidence(
  evidence: z.infer<typeof objectEvidence>,
  connectionId: string,
  name: string
) {
  if (
    evidence.connectionId !== connectionId ||
    evidence.objectName !== name ||
    evidence.active === false ||
    (evidence.status !== undefined && evidence.status !== "ok")
  )
    throw new Error(`CONFIGURATION_OBJECT_EVIDENCE_MISMATCH: ${name}`)
}

/** Metadata only: the existing customizing tier grants no configuration write authority. */
export async function describeConfigurationObject(
  raw: unknown,
  client: string,
  readDefinition: (name: string) => Promise<unknown>,
  readMetadata: (query: unknown) => Promise<unknown>,
  readElement: (name: string) => Promise<unknown>,
  readDomain: (name: string) => Promise<unknown>,
  readImg?: () => Promise<Awaited<ReturnType<typeof findConfigurationActivities>>>,
  readMaintenanceSource?: (name: string) => Promise<unknown>,
  readMaintenanceFunction?: (name: string) => Promise<unknown>
) {
  const input = configurationDescriptorSchema.parse(raw)
  if (input.includeApiMaintenanceBoundary && !input.includeTextMaintenanceBoundary)
    throw new Error("CONFIGURATION_API_MAINTENANCE_TEXT_BOUNDARY_REQUIRED")
  if (
    input.includeTextMaintenanceBoundary &&
    (!input.includeMaintenanceBoundary || input.objectName !== "T006A")
  )
    throw new Error("CONFIGURATION_TEXT_MAINTENANCE_SCOPE_UNSUPPORTED")
  if (input.includeMaintenanceBoundary && !input.includeImg)
    throw new Error("CONFIGURATION_MAINTENANCE_IMG_REQUIRED")
  if (input.language && !input.includeImg)
    throw new Error("CONFIGURATION_OBJECT_IMG_OPTIONS_INVALID")
  if (
    input.includeImg &&
    (input.connectionId !== "w200" ||
      client !== "200" ||
      !["T006", "T006A"].includes(input.objectName))
  )
    throw new Error("CONFIGURATION_OBJECT_IMG_SCOPE_UNSUPPORTED")
  assertTableAllowed(input.objectName)
  if (!(TABLE_TIERS.customizing as readonly string[]).includes(input.objectName))
    throw new Error("CONFIGURATION_OBJECT_SCOPE_UNSUPPORTED: only the approved customizing tier")
  z.string()
    .regex(/^\d{3}$/)
    .parse(client)
  const startedAt = new Date().toISOString()
  const readTable = async () => {
    const rawTable = await readDefinition(input.objectName)
    const envelope = z
      .object({
        status: z.string().optional(),
        active: z.boolean().optional(),
        definition: z.object({ fields: z.array(z.object({ name: z.string() })) }).optional()
      })
      .parse(rawTable)
    if (envelope.status === "not-found") throw new Error("CONFIGURATION_OBJECT_NOT_FOUND")
    if (envelope.active === false) throw new Error("CONFIGURATION_OBJECT_INACTIVE")
    if (
      envelope.definition &&
      (envelope.definition.fields.length > 64 ||
        envelope.definition.fields.some((f) => !identifier.safeParse(f.name).success))
    )
      throw new Error(
        "CONFIGURATION_OBJECT_LAYOUT_UNSUPPORTED: maximum 64 flat fields; no Include/Append markers"
      )
    const result = tableEvidence.parse(rawTable)
    assertEvidence(result, input.connectionId, input.objectName)
    return result
  }
  // ponytail: 64 flat fields bound metadata/API calls; expand only with a reviewed read budget.
  const table = await readTable()
  if (
    input.includeMaintenanceBoundary &&
    table.fingerprint !== configurationUnitLayouts[input.objectName as "T006" | "T006A"]
  )
    throw new Error("CONFIGURATION_MAINTENANCE_LAYOUT_UNVERIFIED")
  if (
    input.expectedDefinitionFingerprint &&
    input.expectedDefinitionFingerprint !== table.fingerprint
  )
    throw new Error("CONFIGURATION_OBJECT_DEFINITION_CHANGED")
  const fields = [...table.definition.fields].sort((a, b) => a.position - b.position)
  if (
    new Set(fields.map((f) => f.name)).size !== fields.length ||
    new Set(fields.map((f) => f.position)).size !== fields.length ||
    !fields.some((f) => f.key)
  )
    throw new Error("CONFIGURATION_OBJECT_FIELDS_INVALID")
  const query = {
    connectionId: input.connectionId,
    tableName: "DD03L",
    columns: ["TABNAME", "AS4LOCAL", "FIELDNAME", "DATATYPE", "LENG", "DECIMALS"],
    filters: [
      { column: "TABNAME", operator: "EQ", value: input.objectName },
      { column: "AS4LOCAL", operator: "EQ", value: "A" }
    ],
    maxRows: 65
  }
  const rawMetadata = await readMetadata(query)
  const metadataStatus = z
    .object({ status: z.string(), code: z.string().optional() })
    .parse(rawMetadata)
  if (metadataStatus.status !== "ok")
    throw new Error(
      `CONFIGURATION_OBJECT_METADATA_UNAVAILABLE: ${metadataStatus.code ?? metadataStatus.status}`
    )
  const metadata = metadataEvidence.parse(rawMetadata)
  if (
    metadata.connectionId !== input.connectionId ||
    metadata.returnedCount !== fields.length ||
    metadata.data.length !== fields.length ||
    new Set(metadata.data.map((f) => f.FIELDNAME)).size !== fields.length ||
    metadata.data.some(
      (f) => f.TABNAME !== input.objectName || !fields.some((v) => v.name === f.FIELDNAME)
    )
  )
    throw new Error("CONFIGURATION_OBJECT_METADATA_MISMATCH")

  const elements = new Map<string, z.infer<typeof elementEvidence>>()
  const domains = new Map<string, z.infer<typeof domainEvidence>>()
  for (const field of fields) {
    if (!field.dataElement || elements.has(field.dataElement)) continue
    const name = identifier.parse(field.dataElement)
    const element = elementEvidence.parse(await readElement(name))
    assertEvidence(element, input.connectionId, name)
    elements.set(name, element)
    if (!element.definition.domainName || domains.has(element.definition.domainName)) continue
    const domainName = identifier.parse(element.definition.domainName)
    const domain = domainEvidence.parse(await readDomain(domainName))
    assertEvidence(domain, input.connectionId, domainName)
    domains.set(domainName, domain)
  }
  const describedFields = fields.map((field) => {
    const scalar = metadata.data.find((f) => f.FIELDNAME === field.name)!
    const element = elements.get(field.dataElement)
    const domain = element ? domains.get(element.definition.domainName) : undefined
    if (
      Number(scalar.LENG) < 1 ||
      (domain &&
        (domain.definition.dataType !== scalar.DATATYPE ||
          domain.definition.length !== Number(scalar.LENG) ||
          domain.definition.decimals !== Number(scalar.DECIMALS)))
    )
      throw new Error(`CONFIGURATION_OBJECT_TYPE_MISMATCH: ${field.name}`)
    return {
      ...field,
      dataType: scalar.DATATYPE,
      length: Number(scalar.LENG),
      decimals: Number(scalar.DECIMALS),
      domainName: element ? element.definition.domainName : null,
      domainMetadataStatus: domain ? "read" : element ? "no_domain" : "unknown",
      foreignKey: { status: "unknown", reason: "DDIC foreign-key relationship was not read" }
    }
  })
  if (input.includeImg && !readImg) throw new Error("CONFIGURATION_OBJECT_IMG_UNAVAILABLE")
  const img = input.includeImg ? await readImg!() : null
  if (
    img &&
    (img.connectionId !== input.connectionId ||
      img.objectName !== input.objectName ||
      img.definitionFingerprint !== table.fingerprint ||
      !img.readOnly ||
      img.saveAvailable)
  )
    throw new Error("CONFIGURATION_OBJECT_IMG_EVIDENCE_MISMATCH")
  const maintenanceBoundary = input.includeMaintenanceBoundary
    ? await inspectUnitMaintenanceRoute(
        img!,
        readImg!,
        readMaintenanceSource,
        input.includeTextMaintenanceBoundary,
        readMaintenanceFunction,
        input.includeApiMaintenanceBoundary
      )
    : null
  const confirmation = await readTable()
  if (confirmation.fingerprint !== table.fingerprint || confirmation.version !== table.version)
    throw new Error("CONFIGURATION_OBJECT_DEFINITION_CHANGED")
  const primaryKey = describedFields.filter((f) => f.key).map((f) => f.name)
  const clientFields = describedFields.filter((f) => f.dataType === "CLNT")
  const clientDependency =
    clientFields.length === 0
      ? "independent"
      : clientFields.length === 1 && describedFields[0] === clientFields[0] && clientFields[0]!.key
        ? "dependent"
        : "unknown"
  const valueObject =
    input.objectName === "T006" || input.objectName === "T006A" ? input.objectName : null
  const valueReadAvailable =
    valueObject !== null &&
    input.connectionId === "w200" &&
    client === "200" &&
    table.fingerprint === configurationUnitLayouts[valueObject] &&
    JSON.stringify(primaryKey) ===
      JSON.stringify(valueObject === "T006" ? ["MANDT", "MSEHI"] : ["MANDT", "SPRAS", "MSEHI"])
  const descriptor = {
    connectionId: input.connectionId,
    sessionClient: client,
    objectName: input.objectName,
    objectKind: table.objectKind,
    packageName: table.packageName,
    definitionVersion: table.version,
    definitionFingerprint: table.fingerprint,
    description: table.definition.description,
    deliveryClass: table.definition.deliveryClass,
    dataBrowserMaintenance: table.definition.dataBrowserMaintenance,
    scope: { tier: "customizing", metadataOnly: true },
    clientDependency,
    clientField: clientDependency === "dependent" ? clientFields[0]!.name : null,
    primaryKey,
    businessKey:
      clientDependency === "unknown"
        ? null
        : primaryKey.filter(
            (name) => clientDependency !== "dependent" || name !== clientFields[0]!.name
          ),
    languageKeyFields: describedFields
      .filter((f) => f.key && f.dataType === "LANG")
      .map((f) => f.name),
    timeDependency: {
      status: "unknown",
      dateFields: describedFields.filter((f) => f.dataType === "DATS").map((f) => f.name)
    },
    fields: describedFields,
    dataElements: [...elements.values()],
    domains: [...domains.values()],
    maintenanceRoute: maintenanceBoundary ?? {
      status: "unknown",
      reason: img
        ? "IMG mapping was read; no official maintenance API was established"
        : "No official maintenance API or maintenance-object mapping was established"
    },
    img: img ?? {
      status: "unknown",
      reason: "IMG activities, paths, transactions and documentation were not read"
    },
    transportPolicy: {
      status: "unknown",
      reason: "Request/task types, client recording policy and E071K key encoding were not verified"
    },
    capabilities: { describe: true, readValues: valueReadAvailable, preview: false, apply: false },
    valueRead: valueReadAvailable
      ? {
          tool: "read_configuration_unit",
          keyField: "MSEHI",
          keyFormat: "internal_case_sensitive",
          client: "200",
          includedFields: configurationUnitFields[valueObject!],
          fieldCoverageComplete: valueObject === "T006A",
          fingerprintScope: "returned_text_projection_only",
          usableForWritePrecondition: false,
          textDraft: {
            tool: "preview_configuration_unit_text",
            fields: ["MSEHT", "MSEHL"],
            requiresReadFingerprint: true,
            executable: false
          }
        }
      : { status: "unsupported" },
    writeRefusalReasons: [
      "MAINTENANCE_API_NOT_VERIFIED",
      "BUSINESS_RULES_NOT_VERIFIED",
      "CTS_KEY_RECORDING_NOT_VERIFIED"
    ]
  }
  return {
    ...descriptor,
    descriptorFingerprint: createHash("sha256").update(JSON.stringify(descriptor)).digest("hex"),
    status: "partial",
    readOnly: true,
    saveAvailable: false,
    evidence: {
      startedAt,
      finishedAt: new Date().toISOString(),
      snapshot: false,
      sources: [
        "read_ddic_transparent_table",
        "read_abap_table(DD03L)",
        "read_ddic_data_element",
        "read_ddic_domain"
      ],
      definitionRechecked: true,
      missing: [
        "foreign_keys",
        "business_semantics",
        "maintenance_route",
        ...(img ? ["complete_img_paths", "documentation_content"] : ["img_mapping"]),
        "cts_policy"
      ]
    },
    warnings: [
      "DDIC maintenance permission and delivery class do not authorize writes or prove a maintenance API.",
      "Sequential metadata reads are not an atomic snapshot; the recheck guards only the table definition."
    ]
  }
}
