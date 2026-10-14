import { createHash } from "node:crypto"
import { z } from "zod"
import type { readConfigurationFiFormulas } from "./configuration-fi-formula.js"
import type { readConfigurationFiDependencies } from "./configuration-fi-dependencies.js"
import { prepareConfigurationFiFieldBridge } from "./configuration-fi-field-bridge.js"

export const configurationFiAnalysisPins = {
  sources: {
    fgbbge01: "04391a37c92535c152193740cd14f505291a803cddfce99cf72aa0c1325ff9be",
    fgbbge02: "6d8391fe922d684ab68e9079abaae786ff2f601f616f8d543328041cf86f79b9",
    fgbbgd00: "505f3de258401240b74d51f61c6626fa26cf9f35f1a5ce26191a5bb81d1eb8f8",
    fgbbge13: "ecab5c871a37b7f3b4db54d4554f3a47f947a56878711bc37413ea2a6dfda8b2",
    lgbl6d00: "ad8a07e8e68a2ed3b392b13a1efdac709a595103e3e4ad73d34d983c45d8e6cb",
    lgbl6f00: "9fa547bd9bdaa3d226cb79f99aab1ee861f194fe5d2eb4160df07526a1d4094d",
    lgbl6f01: "5e386812ba5e2b571c82cd2bb6117aa86f6d78733b08d4765c47db84f489d321",
    lgdiftop: "59f34116e3dc95b860326637cbf57df92d2c5674ef700344210cca276b9ded96",
    lgdiff01: "d6aecc3fb9a2819c92cc1b7fdac0fe3700e30435ebb4963153c0422b2a915245",
    lgdiff02: "0d643b754f1f16b609ce325be936df421d5e82d33ae5f58666b612c9af6bfd51",
    lgdiff03: "480c08552be6f71f2247d6eefc6ccaea55fd9842f8dde4e3c9712651f9761c3b",
    fgbbge07: "f42a8e00073cde213fd5758e2753df4db4d6671fde72df7e3dcb8d5c38789662",
    fgbbgf01: "e53d7976397e5fa27ceaae806630bf1bf1929cb9d8b1f48c51bf25170824549b"
  },
  functions: {
    G_BOOL_GET_ELEMS_FORMULA: {
      source: "71de83eee1c207320df608c1847d9f5cdb1823c5681a8c090800fcd4248a7e65",
      interface: "17e5d4ba1b423798382b343eb8e66cbe75fea3984ff05cf5b6cd6d751437f784"
    },
    G_BOOL_CHECK_SYNTAX: {
      source: "7d027189e9a768ffe40399869227def585fd8ddc2dc251e1ac837077e655cd55",
      interface: "f0a72e2af8480355d3db415bf749e03e12b382ecccf4847a19f9718c44eb3bbf"
    },
    G_BOOL_CLASS_CHECK: {
      source: "6843fe43c8f28991c2604cdc89156b4c6d2fe709e44151edc979b43b23f9986a",
      interface: "d2f4cbc508a7780e4cb7cad89b5d2827fd4e66d2c5ce0d46814309fe43a86eb6"
    },
    G_FIELD_SET: {
      source: "4b2e4f26d3d5bc40cd2b609a15affbab09d37200e001428537edbaeb0fd7678c",
      interface: "2ceaba1c1129c2bd3d6d7d929b19ef292dddad13eb42f8562ca2f99781de1f36"
    },
    G_FIELD_GET: {
      source: "f13a54abc0ea56ff97d60c7de73f2de3f803bdeef31899632bc68248fb497aac",
      interface: "8a5a2202d29b2a20734ad9f43b717c7d7843c83ca6891bbe8b8980125c78aae1"
    },
    G_FIELD_READ: {
      source: "9d4ff1b10b7e71b7727cc3d8485193a75a42878108f8f34e838007fe3025258e",
      interface: "2e8cc10c83d0913d70d3ee8bb7dd47eee1a8016d92c885ba4ac8c82507ebe6b4"
    },
    GBDD_FIELD_SET: {
      source: "9d59a3b1a82306d112c0c0d9229eb3b3e89ac10635fdd2239dca432f64a8a84f",
      interface: "b619db06f20c09834e6bda4a89ae2d5dc311e98fab6572dc0ed0c609df0366f1"
    },
    GBDD_FIELD_GET: {
      source: "1abe6aec29e0437f136afa39d9694fadbe1c55a6c7ae9721359f698985b0ebd2",
      interface: "2e7815956582a0d44a80d6b1f4890aa5d6cfb5a78903930224c7c9164d73942e"
    },
    GBDD_FIELD_READ: {
      source: "84423afbb1bd0aacd880f9d81cefaefc7e07df2c77738069ed2757d4fc7c6554",
      interface: "68478bf1fa9d6fd7bde183666b6d5fd2e12dc434620532ba7a55a1fcf294308f"
    },
    G_CONVERT_INPUT: {
      source: "df57c8ddde8841a19546c6cb7ec64734e07340fb99646ff63513c2d2ee9bca13",
      interface: "8ea584a90955e7db19f5e87824d57f3bcbb0d687808ad40e14e17ed886b7df38"
    },
    G_DDIC_INTERFACE_RESET: {
      source: "09159885c7ff59e36efbff2f9e4a60db20d80428fece134063a9ce51a68f1b27",
      interface: "fd667432000c3ca5f7170ead62e07126fa2ecc8adb1a59673d065957246facaa"
    },
    GBDD_DDIC_INTERFACE_RESET: {
      source: "2c57d0cb15f8dcec024e94289b28429ae3ce3c465d394363962792a26b3254df",
      interface: "fd667432000c3ca5f7170ead62e07126fa2ecc8adb1a59673d065957246facaa"
    }
  },
  DFIES: "0312147abc3e59476c0dd2344eb7d38a11cd71d6ff6ec0f50170a18595525680",
  GLGB_FORMI: "1adfe1edc4734f2b7a7e005f1ba615a7e9890e9d28d428a917417f2f77530cd3",
  BKPF: "8ada572e84d6bb36f6f704f71a2e4d8168b95408e4467885f7a2db6c7d020180",
  SYST: "d4d2336cff5aa7026a21c3af5e71bbbdbbc7e17c8d881ede400c6b9e5b9b3740"
} as const

type Field = { table: string; name: string }
type Expression =
  | {
      kind: "comparison"
      field: Field
      operator: "=" | "<>" | "LIKE"
      nativeOperator: "=" | "<>" | "CP"
      literal: string
    }
  | { kind: "boolean"; operator: "AND" | "OR"; operands: Expression[] }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
function fail(code: string): never {
  throw Error(`FI_RULE_FORMULA_ANALYSIS_${code}`)
}
const codeOf = (error: unknown) =>
  error instanceof Error && /HTTP 401|logon.*failed/i.test(error.message)
    ? "FI_RULE_FORMULA_ANALYSIS_AUTHENTICATION_REJECTED"
    : error instanceof Error && /^FI_RULE_FORMULA_ANALYSIS_[A-Z_]+$/.test(error.message)
      ? error.message
      : "FI_RULE_FORMULA_ANALYSIS_READ_FAILED"

/** A deliberately finite grammar; it never evaluates expressions or calls SAP's stateful parser. */
export function parseFiFormulaSubset(statement: string) {
  if (!statement.length || statement.length > 2700 || /[\u0000-\u001f\u007f]/.test(statement))
    fail("TEXT_SCOPE_UNSUPPORTED")
  // Native comment removal precedes literal extraction, including quotes inside a literal.
  if (statement.includes('"')) fail("COMMENTS_UNSUPPORTED")
  // REMOVE_MATHS also precedes literal extraction and rejects bare MATHS anywhere.
  if (/MATHS/i.test(statement)) fail("MATHS_PREPROCESSING_UNSUPPORTED")
  type Token =
    | { kind: "field"; value: Field }
    | { kind: "literal"; value: string }
    | { kind: "symbol"; value: string }
  const tokens: Token[] = []
  let offset = 0
  while (offset < statement.length) {
    if (statement[offset] === " ") {
      offset++
      continue
    }
    const rest = statement.slice(offset)
    let match = /^<([A-Z][A-Z0-9_]*)> *\$([A-Z][A-Z0-9_]*)/i.exec(rest)
    if (match) {
      const table = match[1]!.toUpperCase(),
        name = match[2]!.toUpperCase()
      if (!["SYST", "BKPF", "BSEG"].includes(table) || name.length > 30)
        fail("FIELD_SCOPE_UNSUPPORTED")
      tokens.push({ kind: "field", value: { table, name } })
    } else if ((match = /^'([^']*)'/.exec(rest))) {
      tokens.push({ kind: "literal", value: match[1]! })
    } else if (/^=[A-Z]/i.test(rest)) {
      fail("EXITS_UNSUPPORTED")
    } else if ((match = /^(AND|OR|LIKE)\b|^(<>|=|\(|\))/i.exec(rest))) {
      tokens.push({ kind: "symbol", value: match[0].toUpperCase() })
    } else {
      if (/^IN\b/i.test(rest)) fail("SETS_UNSUPPORTED")
      if (rest.startsWith("&")) fail("SUBRULES_UNSUPPORTED")
      fail("SYNTAX_SCOPE_UNSUPPORTED")
    }
    offset += match![0].length
    if (tokens.length > 256) fail("TOKEN_LIMIT")
  }
  let position = 0
  const symbol = (value: string) =>
    tokens[position]?.kind === "symbol" && tokens[position]?.value === value
  const fields = new Map<string, Field>()
  const expression = (depth: number): Expression => {
    if (depth > 24) fail("NESTING_LIMIT")
    const atom = (): Expression => {
      if (symbol("(")) {
        position++
        const inner = expression(depth + 1)
        if (!symbol(")")) fail("SYNTAX_SCOPE_UNSUPPORTED")
        position++
        return inner
      }
      const field = tokens[position++],
        operator = tokens[position++],
        literal = tokens[position++]
      if (
        field?.kind !== "field" ||
        operator?.kind !== "symbol" ||
        !["=", "<>", "LIKE"].includes(operator.value) ||
        literal?.kind !== "literal"
      )
        fail("SYNTAX_SCOPE_UNSUPPORTED")
      fields.set(`${field.value.table}-${field.value.name}`, field.value)
      const comparison = operator.value as "=" | "<>" | "LIKE"
      return {
        kind: "comparison",
        field: field.value,
        operator: comparison,
        nativeOperator: comparison === "LIKE" ? "CP" : comparison,
        literal: literal.value
      }
    }
    const operands = [atom()]
    let operator: "AND" | "OR" | undefined
    while (symbol("AND") || symbol("OR")) {
      const current = tokens[position++]!.value as "AND" | "OR"
      // Do not infer precedence for a mixed chain; require explicit grouping in this subset.
      if (operator && current !== operator) fail("MIXED_BOOLEAN_CHAIN_UNSUPPORTED")
      operator = current
      operands.push(atom())
    }
    return operator ? { kind: "boolean", operator, operands } : operands[0]!
  }
  const tree = expression(0)
  if (position !== tokens.length) fail("SYNTAX_SCOPE_UNSUPPORTED")
  return {
    tree,
    fields: [...fields.values()].sort((a, b) =>
      `${a.table}-${a.name}`.localeCompare(`${b.table}-${b.name}`)
    ),
    tokenCount: tokens.length
  }
}

type Content = Awaited<ReturnType<typeof readConfigurationFiFormulas>>
type FieldDefinitions = Awaited<
  ReturnType<typeof readConfigurationFiDependencies>
>["fieldDefinitions"]

function literalRoutes(tree: Expression, definitions: FieldDefinitions): Record<string, unknown>[] {
  if (tree.kind === "boolean")
    return tree.operands.flatMap((operand) => literalRoutes(operand, definitions))
  const field = definitions.find(
    (field) => field.table === tree.field.table && field.name === tree.field.name
  )!
  return [
    {
      ...tree.field,
      operator: tree.operator,
      literal: tree.literal,
      conversionExit: field.conversionExit,
      specialFormulaCheck:
        tree.literal.length && field.conversionExit && field.conversionExit !== "ALPHA"
          ? "conditional_route_requires_G_CONVERT_INPUT"
          : "conditional_route_skips_conversion",
      generatedComparison:
        tree.operator === "LIKE"
          ? "CP_skips_CONVERT_DATA_TYPE"
          : !tree.literal.length
            ? "empty_quoted_literal_skips_conversion"
            : field.conversionExit
              ? "CONVERT_DATA_TYPE_requires_G_CONVERT_INPUT"
              : "CONVERT_DATA_TYPE_no_exit_for_observed_CHAR_QUAN",
      convertedValue: null,
      runtimeVerified: false,
      nativeOutputLength: "not_observed_from_DFIES",
      sourceOwners: [
        "FGBBGF01:CHECK_FORMULA_SPECIAL",
        "FGBBGE07:MAKE_FIELD_CODE/CONVERT_DATA_TYPE"
      ],
      limits: {
        conversionBufferCharacters: 80,
        conversionInputWithinBuffer: tree.literal.length <= 80,
        conversionInputValidated: false
      }
    }
  ]
}

function nativeFieldRoute(fields: FieldDefinitions, booleanClass: string) {
  return {
    status: "source_routes_attested_execution_unverified",
    classCheck: "G_BOOL_CLASS_CHECK/INITIALIZE_CLASSES",
    classType: "B",
    wildcardFields: "G_FIELD_SET/G_FIELD_GET",
    exactField: "G_FIELD_READ",
    dispatch: "GDIF CHECK_TFDIR selects GBDD when GBDD_FIELD_READ exists",
    delegates: ["GBDD_FIELD_SET", "GBDD_FIELD_GET", "GBDD_FIELD_READ"],
    fallback: "GDIF DDIF_NAMETAB_GET/DDIF_FIELDINFO_GET buffer",
    sessionState: "GDIF cached dispatch and buffers; GBDD FT cursor and field buffers",
    fieldSwitches: "GBDD_FIELD_SET exclude_field BAdI; runtime implementations unverified",
    aliasNormalization: { input: "SY", ddicTable: "SYST", sourceAttested: true },
    conversion: {
      owner: "G_CONVERT_INPUT",
      genericParameters: "ANY; local interface is not RFC compatible",
      lowercaseDefault: "X",
      applied: false
    },
    remoteEnabled: false,
    nativeEligibility: "not_checked",
    bridgeRequired: true,
    complete: false,
    bridgePreparation: prepareConfigurationFiFieldBridge(
      fields.map(({ table, name }) => ({ table, name })),
      booleanClass
    )
  }
}

type Metadata = {
  connectionId: string
  objectName: string
  objectKind: string
  fingerprint: string
  active?: boolean
  definition: { fields: { name: string; dataElement?: string }[] }
}

export async function analyzeConfigurationFiFormulas(
  content: Content | null,
  booleanClass: string,
  readers: {
    source(uri: string): Promise<{ source: string; uriUsed: string }>
    function(name: string): Promise<unknown>
    structure(name: string): Promise<unknown>
    table(name: string): Promise<unknown>
    dependencies?(
      fields: Field[],
      booleanClass: string
    ): ReturnType<typeof readConfigurationFiDependencies>
  }
) {
  const startedAt = new Date().toISOString(),
    blockers: string[] = []
  const evidence: { object: string; status: string; code?: string }[] = []
  let items:
    | {
        formulaId: string
        status: string
        statement: string
        tree: Expression | null
        literalEvidence?: Record<string, unknown>[]
        code?: string
      }[]
    | null = null
  let dependencies:
    | { table: string; name: string; status: string; dataElement: string | null }[]
    | null = null
  let syntaxSubsetComplete = false,
    fieldDefinitionsComplete = false,
    definitionsRechecked = false
  let readFingerprint: string | null = null
  let fieldEvidence: Awaited<ReturnType<typeof readConfigurationFiDependencies>> | null = null
  let nativeRoute: ReturnType<typeof nativeFieldRoute> | null = null
  const attest = async () => {
    for (const [name, pin] of Object.entries(configurationFiAnalysisPins.functions)) {
      if (
        !z
          .object({
            connectionId: z.literal("w200"),
            functionName: z.literal(name),
            remoteEnabled: z.literal(false),
            updateTask: z.literal(false),
            sourceFingerprint: z.literal(pin.source),
            interfaceFingerprint: z.literal(pin.interface)
          })
          .safeParse(await readers.function(name)).success
      )
        fail("STANDARD_SOURCE_CHANGED")
      evidence.push({ object: name, status: "attested" })
    }
    for (const [name, pin] of Object.entries(configurationFiAnalysisPins.sources)) {
      const uri =
        name.startsWith("lgbl6") || name.startsWith("lgdif")
          ? `/sap/bc/adt/functions/groups/${name.startsWith("lgdif") ? "gdif" : "gbl6"}/includes/${name}`
          : `/sap/bc/adt/programs/includes/${name}`
      const result = await readers.source(uri)
      if (
        result.uriUsed !== uri + "/source/main" ||
        createHash("sha256").update(result.source).digest("hex") !== pin
      )
        fail("STANDARD_SOURCE_CHANGED")
      evidence.push({ object: name, status: "attested" })
    }
    for (const name of ["GLGB_FORMI", "DFIES"] as const)
      if (
        !z
          .object({
            connectionId: z.literal("w200"),
            objectName: z.literal(name),
            objectKind: z.literal("structure"),
            fingerprint: z.literal(configurationFiAnalysisPins[name]),
            active: z.literal(true).optional()
          })
          .safeParse(await readers.structure(name)).success
      )
        fail(name === "DFIES" ? "NATIVE_FIELD_STRUCTURE_CHANGED" : "TOKEN_STRUCTURE_CHANGED")
  }
  const metadata: Record<string, Metadata | null> = {}
  try {
    if (
      content?.status !== "raw_content_read" ||
      !content.items?.length ||
      hash({
        client: "200",
        booleanClass,
        references: content.references,
        items: content.items
      }) !== content.readFingerprint
    )
      fail("CONTENT_UNAVAILABLE")
    await attest()
    const fields = new Map<string, Field>()
    items = content.items.map((item) => {
      let statement = ""
      try {
        // Cross-row literal continuation needs native normalization evidence beyond this subset.
        if (item.lines.some((line) => (line.BOOLEXP!.match(/'/g) ?? []).length % 2))
          fail("CROSS_ROW_LITERAL_UNSUPPORTED")
        statement = item.lines.map((line) => line.BOOLEXP!.replace(/ +$/, "")).join(" ")
        const parsed = parseFiFormulaSubset(statement)
        for (const field of parsed.fields) fields.set(`${field.table}-${field.name}`, field)
        return { formulaId: item.formulaId, status: "subset_parsed", statement, tree: parsed.tree }
      } catch (error) {
        const code = codeOf(error)
        blockers.push(code)
        return { formulaId: item.formulaId, status: "unsupported", statement, tree: null, code }
      }
    })
    syntaxSubsetComplete = items.every((item) => item.status === "subset_parsed")
    if (readers.dependencies && fields.size) {
      fieldEvidence = await readers.dependencies(
        [...fields.values()].sort((a, b) =>
          `${a.table}-${a.name}`.localeCompare(`${b.table}-${b.name}`)
        ),
        booleanClass
      )
      dependencies = fieldEvidence.fieldDefinitions
      blockers.push(...fieldEvidence.blockers)
    } else {
      for (const name of [...new Set([...fields.values()].map((field) => field.table))].sort()) {
        try {
          if (name === "BSEG") fail("FIELD_METADATA_UNSUPPORTED")
          const result = (
            name === "SYST" ? await readers.structure(name) : await readers.table(name)
          ) as Metadata
          if (
            result?.connectionId !== "w200" ||
            result.objectName !== name ||
            result.objectKind !== (name === "SYST" ? "structure" : "transparentTable") ||
            result.fingerprint !== configurationFiAnalysisPins[name as "BKPF" | "SYST"] ||
            result.active === false ||
            hash(result.definition) !== result.fingerprint ||
            !Array.isArray(result.definition?.fields)
          )
            fail("FIELD_METADATA_CHANGED")
          metadata[name] = result
          evidence.push({ object: name, status: "attested" })
        } catch (error) {
          if (codeOf(error) === "FI_RULE_FORMULA_ANALYSIS_AUTHENTICATION_REJECTED") throw error
          const code =
            error instanceof Error && /OBJECT_TYPE_MISMATCH/.test(error.message)
              ? "FI_RULE_FORMULA_ANALYSIS_FIELD_METADATA_UNSUPPORTED"
              : codeOf(error)
          if (code !== "FI_RULE_FORMULA_ANALYSIS_FIELD_METADATA_UNSUPPORTED") throw error
          metadata[name] = null
          blockers.push(code)
          evidence.push({ object: name, status: "unsupported", code })
        }
      }
      dependencies = [...fields.values()]
        .sort((a, b) => `${a.table}-${a.name}`.localeCompare(`${b.table}-${b.name}`))
        .map((field) => {
          const definition = metadata[field.table]?.definition.fields.find(
            (entry) => entry.name === field.name
          )
          return {
            ...field,
            status: metadata[field.table]
              ? definition
                ? "ddic_field_observed"
                : "field_not_found"
              : "metadata_unsupported",
            dataElement: definition?.dataElement ?? null
          }
        })
    }
    fieldDefinitionsComplete = dependencies.every((field) => field.status === "ddic_field_observed")
    if (!fieldDefinitionsComplete)
      blockers.push("FI_RULE_FORMULA_ANALYSIS_FIELD_DEFINITIONS_INCOMPLETE")
    await attest()
    for (const [name, first] of Object.entries(metadata))
      if (first) {
        const confirmation = (
          name === "SYST" ? await readers.structure(name) : await readers.table(name)
        ) as Metadata
        if (
          confirmation?.connectionId !== first.connectionId ||
          confirmation.objectName !== first.objectName ||
          confirmation.objectKind !== first.objectKind ||
          confirmation.fingerprint !== first.fingerprint ||
          confirmation.active === false ||
          hash(confirmation.definition) !== first.fingerprint
        )
          fail("FIELD_METADATA_CHANGED")
      }
    definitionsRechecked = true
    if (syntaxSubsetComplete && fieldDefinitionsComplete && fieldEvidence) {
      nativeRoute = nativeFieldRoute(fieldEvidence.fieldDefinitions, booleanClass)
      for (const item of items)
        if (item.tree)
          item.literalEvidence = literalRoutes(item.tree, fieldEvidence.fieldDefinitions)
      blockers.push(
        "FI_RULE_FORMULA_ANALYSIS_NATIVE_FIELD_RFC_BRIDGE_REQUIRED",
        "FI_RULE_FORMULA_ANALYSIS_NATIVE_FIELD_SWITCHES_UNVERIFIED"
      )
    }
    if (syntaxSubsetComplete && fieldDefinitionsComplete)
      readFingerprint = hash({
        contentFingerprint: content.readFingerprint,
        items,
        dependencies,
        ...(nativeRoute ? { nativeRoute } : {}),
        ...(fieldEvidence ? { dependencyFingerprint: fieldEvidence.readFingerprint } : {})
      })
  } catch (error) {
    blockers.push(codeOf(error))
    items = null
    dependencies = null
    fieldEvidence = null
    nativeRoute = null
    syntaxSubsetComplete = false
    fieldDefinitionsComplete = false
  }
  if (!fieldEvidence) blockers.push("FI_RULE_FORMULA_ANALYSIS_CLASS_PERMISSION_UNVERIFIED")
  blockers.push(
    "FI_RULE_FORMULA_ANALYSIS_LITERAL_CONVERSIONS_UNVERIFIED",
    "FI_RULE_FORMULA_ANALYSIS_NATIVE_NORMALIZATION_UNVERIFIED"
  )
  return {
    status: !items ? "unavailable" : syntaxSubsetComplete ? "subset_parsed" : "partial",
    readOnly: true,
    saveAvailable: false,
    contentFingerprint: content?.readFingerprint ?? null,
    items,
    dependencies,
    fieldEvidence,
    nativeRoute,
    readFingerprint,
    blockers: [...new Set(blockers)],
    coverage: {
      complete: false,
      syntaxSubsetComplete,
      fieldDefinitionsComplete,
      grammar: "field_quoted_literal_eq_ne_like_grouped_and_or",
      statements: "stored_rows_trimmed_right_joined_with_space",
      nativeEvaluation: "not_performed",
      nativeSyntaxCheck: "not_performed",
      nativeNormalization: "not_verified",
      nativeFieldRoute: nativeRoute ? "source_attested_execution_unverified" : "not_checked",
      classPermissions: fieldEvidence
        ? "policy_observed_native_eligibility_unverified"
        : "not_checked",
      literalConversions: fieldEvidence ? "attributes_observed_not_applied" : "not_checked",
      setsSubrulesExits: "unsupported_fail_closed",
      snapshot: false
    },
    evidence: {
      startedAt,
      finishedAt: new Date().toISOString(),
      sources: evidence,
      definitionsRechecked
    }
  }
}
