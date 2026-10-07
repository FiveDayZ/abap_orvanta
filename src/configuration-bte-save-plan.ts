import { z } from "zod"
import { configurationBteMetadataResponse } from "./configuration-bte-metadata.js"
import { configurationBteSaveApiPins } from "./configuration-bte-save-api.js"

const value = (length: number) =>
  z
    .string()
    .max(length)
    .refine((s) => !/[\p{Cc}\p{Cs}]/u.test(s) && !/[\uD800-\uDFFF]/.test(s))
const product = z
  .object({
    MANDT: z.literal("200"),
    PRDKT: z.string().regex(/^[ZY][A-Z0-9_]{0,7}$/),
    RFCDS: value(32),
    AKTIV: z.enum(["", "X"])
  })
  .strict()
const text = z
  .object({
    MANDT: z.literal("200"),
    SPRAS: value(1).refine((s) => s.trim().length === 1),
    PRDKT: z.string().regex(/^[ZY][A-Z0-9_]{0,7}$/),
    TXT50: value(50)
  })
  .strict()

function fail(code: string): never {
  throw Error(`BTE_SAVE_PLAN_${code}`)
}

/** Source/ABI checks are reads; no maintenance, lock, CTS or cache API is invoked here. */
export async function attestConfigurationBteSaveApis(read: (name: string) => Promise<unknown>) {
  const records = await Promise.allSettled(
    Object.entries(configurationBteSaveApiPins).map(async ([name, pin]) => {
      const d = z
        .object({
          connectionId: z.literal("w200"),
          functionName: z.literal(name),
          functionGroup: z.literal(pin.functionGroup),
          sourceFingerprint: z.literal(pin.source),
          interfaceFingerprint: z.literal(pin.interface),
          remoteEnabled: z.literal(pin.remoteEnabled),
          updateTask: z.literal(pin.updateTask),
          updateTaskMode: z.literal(pin.updateTaskMode),
          globalInterface: z.literal(pin.globalInterface)
        })
        .safeParse(await read(name))
      if (!d.success) fail("API_UNVERIFIED")
      return [name, pin] as const
    })
  )
  if (records.some((r) => r.status === "rejected")) fail("API_UNVERIFIED")
  return Object.fromEntries(
    records.map((r) => {
      if (r.status !== "fulfilled") fail("API_UNVERIFIED")
      return r.value
    })
  )
}

// Byte offsets from the actual w200 native namtab, not JS string offsets.
const fields = [
  ["TBE24", "MANDT", 0, 3, "CLNT", "X"],
  ["TBE24", "PRDKT", 6, 8, "CHAR", "X"],
  ["TBE24", "RFCDS", 22, 32, "CHAR", ""],
  ["TBE24", "AKTIV", 86, 1, "CHAR", ""],
  ["TBE24T", "MANDT", 88, 3, "CLNT", "X"],
  ["TBE24T", "SPRAS", 94, 1, "LANG", "X"],
  ["TBE24T", "PRDKT", 96, 8, "CHAR", "X"],
  ["TBE24T", "TXT50", 112, 50, "CHAR", ""]
] as const

/**
 * Build one possible VIM TOTAL row per language. The future SAP worker must select exactly
 * sy-langu after its locked read; these alternatives must never be submitted together.
 * Only entity AKTIV changes. Mark and text-action stay original, preserving every text row.
 */
export function buildConfigurationBteSaveContainers(
  rawMetadata: unknown,
  rawBefore: unknown,
  rawAfter: unknown,
  rawTexts: unknown
) {
  const native = configurationBteMetadataResponse.safeParse(rawMetadata)
  const before = product.safeParse(rawBefore),
    after = product.safeParse(rawAfter)
  const texts = z.array(text).max(200).safeParse(rawTexts)
  if (!native.success || !before.success || !after.success || !texts.success) fail("INPUT_INVALID")
  const a = before.data,
    b = after.data,
    h = native.data.ET_HEADER[0]!
  if (a.MANDT !== b.MANDT || a.PRDKT !== b.PRDKT || a.RFCDS !== b.RFCDS)
    fail("FIELD_CHANGE_UNSUPPORTED")
  if (texts.data.some((t) => t.MANDT !== a.MANDT || t.PRDKT !== a.PRDKT))
    fail("TEXT_SCOPE_MISMATCH")
  if (new Set(texts.data.map((t) => t.SPRAS)).size !== texts.data.length) fail("TEXT_DUPLICATE")
  if (
    h.VIEWNAME !== "TBE24" ||
    h.MAINTVIEW !== "TBE24" ||
    h.AREA !== "BFTM" ||
    h.FPOOLNAME !== "SAPLBFTM" ||
    h.BASTAB !== "X" ||
    h.TEXTTAB !== "TBE24T" ||
    h.NEWGENER !== "" ||
    h.FLAG !== "" ||
    h.RDONLYFLAG !== "" ||
    h.CLIDEP !== "X" ||
    h.TEXTCLIDEP !== "X" ||
    h.TEXTTBEXST !== "X" ||
    Number(h.TABLEN) !== 88 ||
    Number(h.AFTER_TABC) !== 88 ||
    Number(h.TEXTTABLEN) !== 124 ||
    Number(h.AFT_TXTTBC) !== 124 ||
    Number(h.KEYLEN) !== 22 ||
    Number(h.TEXTKEYLEN) !== 24 ||
    h.FRM_AF_SAV !== "CONTEXT_BUFFER_DELETE_CUS" ||
    Object.entries(h).some(([k, v]) => k.startsWith("FRM_") && k !== "FRM_AF_SAV" && v !== "") ||
    native.data.ET_EVENTS.length !== 1 ||
    !native.data.ET_EVENTS.some(
      (e) => e.EVENT === "02" && e.TABNAME === "TBE24" && e.FORMNAME === h.FRM_AF_SAV
    )
  )
    fail("LAYOUT_UNSUPPORTED")
  if (native.data.ET_NAMTAB.length !== fields.length) fail("LAYOUT_UNSUPPORTED")
  for (let i = 0; i < fields.length; i++) {
    const [table, name, offset, length, type, key] = fields[i]!,
      n = native.data.ET_NAMTAB[i]!
    if (
      n.BASTABNAME !== table ||
      n.BASTABFLD !== name ||
      n.VIEWFIELD !== name ||
      Number(n.POSITION) !== offset ||
      Number(n.FLENGTH) !== length * 2 ||
      n.INTTYPE !== "C" ||
      n.DATATYPE !== type ||
      n.KEYFLAG !== key ||
      n.TEXTTABFLD !== (table === "TBE24T" ? "X" : "")
    )
      fail("LAYOUT_UNSUPPORTED")
  }
  const changed = a.AKTIV !== b.AKTIV
  function row(p: z.output<typeof product>, t: z.output<typeof text>) {
    const entity: Record<string, string> = p,
      languageText: Record<string, string> = t
    const content = fields
      .map(([table, name, , length]) =>
        (table === "TBE24" ? entity[name]! : languageText[name]!).padEnd(length, " ")
      )
      .join("")
    // LSVIMF44 places action, mark and text-action after both full DDIC records.
    return content + (changed ? "U" : " ") + "  "
  }
  const languageCandidates = [...texts.data]
    .sort((x, y) => (x.SPRAS < y.SPRAS ? -1 : x.SPRAS > y.SPRAS ? 1 : 0))
    .map((t) => ({
      language: t.SPRAS,
      save: { total: [row(b, t)], extract: [] as string[] },
      recover: { total: [row(a, t)], extract: [] as string[] }
    }))
  return {
    status: "native_container_prepared" as const,
    characterWidthBytes: 2,
    entityCharacters: 44,
    textCharacters: 62,
    rowCharacters: 109,
    offsets: { activation: 43, action: 106, mark: 107, textAction: 108 },
    rowAction: changed ? "U" : " ",
    textAction: " ",
    languageCandidates,
    selectExactlyOneAuthenticatedSapLanguage: true,
    missingLogonLanguageRequiresNativeRead: true,
    requireLockedFreshRead: true,
    nativeSerializationVerified: false,
    executable: false,
    writeAvailable: false
  }
}

export const configurationBteSaveSessionRequirements = {
  maintenance: { functionName: "VIEW_MAINTENANCE_NO_DIALOG", action: "SAVE", importMode: "D" },
  transportDialogs: { functionName: "VIM_SET_NO_TR_DIALOG", enable: "X", clearOnEveryExit: "" },
  cts: {
    functionName: "CTS_WBO_API_INSERT_OBJECTS",
    noExplicitDbcommit: "X",
    requireExistingRequestAndTask: true
  },
  locks: { functionName: "VIEW_ENQUEUE", mode: "E", includeLanguageTextTable: true },
  messages: { functionName: "VIM_GET_TR_MESSAGES", drainOnEntryAndEveryExit: true },
  rejectEnabledExternalSynchronizerUntilVerified: true,
  requireExplicitNativeCommitOwnership: true,
  requireFullPersistedReadbackAndCtsKeys: true,
  retryUnknownOutcome: false,
  restoreOldCacheTimestamp: false,
  nativeExecutionVerified: false
} as const
