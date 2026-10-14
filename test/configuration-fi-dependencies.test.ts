import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import type { SapBackend } from "../src/backend.js"
import { readConfigurationFiDependencies } from "../src/configuration-fi-dependencies.js"
import { NATIVE_PREVIEW_EMPTY_HTML } from "../src/reviewed-table-reader.js"

const observed = JSON.parse(
  readFileSync(
    new URL("./fixtures/configuration-fi-dependencies-w200-r89.json", import.meta.url),
    "utf8"
  )
) as {
  metadata: Record<string, Record<string, unknown>>
  fields: Record<string, string>[]
  classification: Record<string, string>[]
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const allFields = observed.fields.map((f) => ({ table: f.TABNAME!, name: f.FIELDNAME! }))
function harness() {
  const calls: string[] = []
  // Synthetic class policy, kept separate from the actual SAP DDIC fixture.
  const policies: Record<string, Record<string, string>[]> = {
    GB01: ["BKPF", "BSEG", "SYST"].map((BCLTAB) => ({
      BOOLCLASS: "009",
      CLASSTYPE: "A",
      BCLTAB,
      BCLFIELD: "*",
      BEXCLUDE: ""
    })),
    GB01C: []
  }
  const query = async (table: string, filters: Record<string, string>) => {
    calls.push(table)
    const rows =
      table === "DD02L"
        ? observed.classification
        : table === "DD03L"
          ? observed.fields
          : policies[table]!
    assert(rows, "No unrelated or business table read")
    return structuredClone(
      rows.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v))
    )
  }
  const backend: Pick<SapBackend, "runQuery" | "callRemoteFunction"> = {
    async runQuery(_id, sql) {
      assert(!/\bFROM BSEG\b/.test(sql), "BSEG data is forbidden")
      const table = sql.match(/ FROM (\w+)/)![1]!
      const filters = Object.fromEntries(
        [...sql.matchAll(/(\w+) = '([^']*)'/g)].map((m) => [m[1]!, m[2]!])
      )
      return query(table, filters)
    },
    async callRemoteFunction() {
      throw Error("Unexpected fallback")
    }
  }
  const definitions = async (kind: string, objectName: string) => {
    calls.push(`${kind}:${objectName}`)
    assert(observed.metadata[`${kind}:${objectName}`])
    return structuredClone(observed.metadata[`${kind}:${objectName}`]!)
  }
  const readers = {
    table: (name: string) => definitions("transparentTable", name),
    dataElement: (name: string) => definitions("dataElement", name),
    domain: (name: string) => definitions("domain", name),
    async function(name: string): Promise<unknown> {
      calls.push(name)
      return {
        functionName: "RFC_READ_TABLE",
        remoteEnabled: true,
        updateTask: false,
        sourceFingerprint: "7b9a603493673d26f75e555616b24d150e407ce03eff57e9c68f0b30b1ba0c2d",
        interfaceFingerprint: "d06cc5c1ce05960bde526ecf27e38606134146474cc8da19f93ac2abd3e48074"
      }
    }
  }
  return { calls, policies, query, backend, readers }
}

test("FI dependencies cover nine actual DDIC fields and expose conversion attributes without applying them", async () => {
  const h = harness()
  const result = await readConfigurationFiDependencies(allFields, "009", h.backend, h.readers)
  assert.equal(result.fieldDefinitions.length, 9)
  const account = result.fieldDefinitions.find((f) => f.name === "HKONT")!
  assert.equal(account.dataElement, "HKONT")
  assert.equal(account.conversionExit, "ALPHA")
  const material = result.fieldDefinitions.find((f) => f.name === "MATNR")!
  assert.equal(material.conversionExit, "MATN1")
  const quantity = result.fieldDefinitions.find((f) => f.name === "MENGE")!
  assert.deepEqual(
    [quantity.dataType, quantity.length, quantity.decimals, quantity.referenceField],
    ["QUAN", 13, 3, "MEINS"]
  )
  assert(
    result.classPolicy.every((p) => p.status === "policy_included_native_eligibility_unverified")
  )
  assert.equal(result.coverage.definitionsRechecked, true)
  assert.equal(
    result.coverage.classPolicyScope,
    "referenced_fields_and_table_wildcards_including_SY_alias"
  )
  assert.equal(result.coverage.maximumPolicyRowsPerSelector, 3)
  assert.equal(result.coverage.complete, false)
  assert.equal(result.saveAvailable, false)
  assert(result.readFingerprint)
})

test("FI read policy merges customer exclusions and never treats write-only rows as read permission", async () => {
  const h = harness()
  h.policies.GB01 = [
    { BOOLCLASS: "009", CLASSTYPE: "S", BCLTAB: "BSEG", BCLFIELD: "MATNR", BEXCLUDE: "" }
  ]
  h.policies.GB01C!.push({
    MANDT: "200",
    BOOLCLASS: "009",
    CLASSTYPE: "B",
    BCLTAB: "BSEG",
    BCLFIELD: "HKONT",
    BEXCLUDE: "X"
  })
  const result = await readConfigurationFiDependencies(allFields, "009", h.backend, h.readers)
  assert.equal(result.classPolicy.find((f) => f.name === "HKONT")!.status, "policy_excluded")
  assert.equal(result.classPolicy.find((f) => f.name === "MATNR")!.status, "policy_not_included")
  assert(result.blockers.includes("FI_RULE_FORMULA_ANALYSIS_CLASS_POLICY_EXCLUDED"))
  assert.equal(result.coverage.substitutionWritePermission, "not_checked")
})

test("FI class aliases remain explicit unresolved policy instead of inferring native SYST eligibility", async () => {
  const h = harness()
  h.policies.GB01 = [
    { BOOLCLASS: "009", CLASSTYPE: "B", BCLTAB: "SY", BCLFIELD: "*", BEXCLUDE: "" }
  ]
  const result = await readConfigurationFiDependencies(
    [{ table: "SYST", name: "TCODE" }],
    "009",
    h.backend,
    h.readers
  )
  assert.equal(result.classPolicy[0]!.status, "alias_resolution_unverified")
})

test("FI policy reads only referenced field and wildcard keys even when the class has over 128 unrelated rows", async () => {
  const h = harness()
  h.policies.GB01!.push(
    ...Array.from({ length: 150 }, (_, i) => ({
      BOOLCLASS: "009",
      CLASSTYPE: "A",
      BCLTAB: "BSEG",
      BCLFIELD: `UNRELATED_${i}`,
      BEXCLUDE: ""
    }))
  )
  h.policies.GB01C!.push({
    MANDT: "200",
    BOOLCLASS: "009",
    CLASSTYPE: "B",
    BCLTAB: "BSEG",
    BCLFIELD: "HKONT",
    BEXCLUDE: "X"
  })
  const query = h.backend.runQuery
  const scopes: string[] = []
  h.backend.runQuery = async (...args) => {
    if (args[1].includes("FROM GB01")) {
      assert.match(args[1], / AND BCLTAB = '[A-Z]+' AND BCLFIELD = '[A-Z0-9_*]+'/)
      assert.equal(args[2], 4, "Each selector has three class types plus one overflow probe")
      scopes.push(args[1])
    }
    return query(...args)
  }
  const result = await readConfigurationFiDependencies(allFields, "009", h.backend, h.readers)
  assert.equal(scopes.length, 56, "Fourteen unique selectors per table, read twice")
  assert.equal(new Set(scopes).size, 28)
  assert.equal(result.policies.length, 4)
  assert(result.policies.every((p) => !p.BCLFIELD.startsWith("UNRELATED_")))
  assert.equal(result.classPolicy.find((f) => f.name === "HKONT")!.status, "policy_excluded")
  assert.equal(
    result.classPolicy.find((f) => f.name === "MATNR")!.status,
    "policy_included_native_eligibility_unverified"
  )
  assert.equal(result.coverage.complete, false)
  assert.equal(result.saveAvailable, false)
})

test("FI policy duplicate primary keys with different exclusion values are refused", async () => {
  const h = harness()
  h.policies.GB01!.push({ ...h.policies.GB01![0]!, BEXCLUDE: "X" })
  await assert.rejects(
    readConfigurationFiDependencies(allFields, "009", h.backend, h.readers),
    /CLASS_POLICY_AMBIGUOUS/
  )
})

test("FI dependency scope rejects other classes, unknown fields, duplicates and limits before any read", async () => {
  for (const [fields, cls] of [
    [allFields, "010"],
    [[{ table: "BSEG", name: "UNKNOWN" }], "009"],
    [[], "009"],
    [[...allFields, allFields[0]!], "009"],
    [[allFields[0]!, allFields[0]!], "009"]
  ] as const) {
    const h = harness()
    await assert.rejects(
      readConfigurationFiDependencies([...fields], cls, h.backend, h.readers),
      /DEPENDENCY_SCOPE_UNSUPPORTED/
    )
    assert.equal(h.calls.length, 0)
  }
})

test("FI dependency metadata values, classification, rows and relations fail closed", async () => {
  for (const mode of [
    "classification",
    "missing",
    "duplicate",
    "policy-limit",
    "policy-type",
    "wrong-client",
    "wrong-class",
    "relation",
    "inactive",
    "hash",
    "version"
  ] as const) {
    const h = harness()
    const query = h.backend.runQuery
    h.backend.runQuery = async (...args) => {
      const rows = await query(...args)
      if (mode === "classification" && args[1].includes("FROM DD02L")) rows[0]!.TABCLASS = "TRANSP"
      if (args[1].includes("FROM DD03L")) {
        if (mode === "missing") return []
        if (mode === "duplicate") return [...rows, rows[0]!]
      }
      if (args[1].includes("FROM GB01") && rows.length) {
        if (mode === "policy-limit") return Array(4).fill(rows[0])
        if (mode === "policy-type") rows[0]!.CLASSTYPE = "Z"
        if (mode === "wrong-class") rows[0]!.BOOLCLASS = "010"
      }
      if (mode === "wrong-client" && args[1].includes("FROM GB01C"))
        return [
          {
            MANDT: "300",
            BOOLCLASS: "009",
            CLASSTYPE: "B",
            BCLTAB: "BKPF",
            BCLFIELD: "*",
            BEXCLUDE: ""
          }
        ]
      return rows
    }
    const domain = h.readers.domain
    h.readers.domain = async (name) => {
      const value = await domain(name)
      if (mode === "relation") {
        ;(value.definition as Record<string, unknown>).length = 99
        value.fingerprint = hash(value.definition)
      }
      if (mode === "inactive") value.active = false
      if (mode === "hash") value.fingerprint = "0".repeat(64)
      if (mode === "version") value.version = ""
      return value
    }
    await assert.rejects(
      readConfigurationFiDependencies(allFields, "009", h.backend, h.readers),
      /FI_RULE_FORMULA_ANALYSIS_/,
      mode
    )
  }
})

test("FI dependency confirmation detects row, policy, domain and concurrency version drift", async () => {
  for (const mode of ["field", "policy", "domain", "version"]) {
    const h = harness()
    let observations = 0
    const query = h.backend.runQuery
    h.backend.runQuery = async (...args) => {
      const rows = await query(...args)
      if (args[1].includes("FROM DD02L")) observations++
      if (observations > 1 && mode === "field" && args[1].includes("FROM DD03L"))
        rows[0]!.ROLLNAME = "CHANGED"
      if (observations > 1 && mode === "policy" && args[1].includes("FROM GB01 ") && rows.length)
        rows[0]!.BEXCLUDE = "X"
      return rows
    }
    let domains = 0
    const domain = h.readers.domain
    h.readers.domain = async (name) => {
      const value = await domain(name)
      if (++domains > 9) {
        if (mode === "domain") {
          ;(value.definition as Record<string, unknown>).lowercase = true
          value.fingerprint = hash(value.definition)
        }
        if (mode === "version") value.version = "changed"
      }
      return value
    }
    await assert.rejects(
      readConfigurationFiDependencies(allFields, "009", h.backend, h.readers),
      /DEPENDENCY_(VALUES|METADATA)_CHANGED/,
      mode
    )
  }
})

test("FI dependency legacy read fallback preserves fixed bounded metadata scope and validates reader before execution", async () => {
  const h = harness()
  h.backend.runQuery = async () => {
    throw Error(NATIVE_PREVIEW_EMPTY_HTML)
  }
  h.backend.callRemoteFunction = async (_id, request) => {
    assert.equal(request.functionName, "RFC_READ_TABLE")
    const input = request.inputParameters
    const columns = (input.FIELDS as { FIELDNAME: string }[]).map((f) => f.FIELDNAME)
    const filters = Object.fromEntries(
      (input.OPTIONS as { TEXT: string }[]).map((o) => {
        const m = o.TEXT.match(/(\w+) = '([^']*)'/)!
        return [m[1]!, m[2]!]
      })
    )
    const rows = await h.query(String(input.QUERY_TABLE), filters)
    return {
      functionName: "RFC_READ_TABLE",
      outputs: {
        FIELDS: columns.map((FIELDNAME) => ({ FIELDNAME })),
        DATA: rows.map((r) => ({ WA: columns.map((c) => r[c]).join("|") }))
      }
    }
  }
  const result = await readConfigurationFiDependencies(allFields, "009", h.backend, h.readers)
  assert(result.evidence.sources.every((s) => s.method === "rfc_read_table"))
  assert.equal(h.calls.filter((c) => c === "RFC_READ_TABLE").length, 1)
  h.readers.function = async () => ({})
  await assert.rejects(
    readConfigurationFiDependencies(allFields, "009", h.backend, h.readers),
    /FALLBACK_UNVERIFIED/
  )
})

test("FI dependency authentication rejection immediately stops metadata/query/confirmation reads", async () => {
  const h = harness()
  h.backend.runQuery = async () => {
    h.calls.push("401")
    throw Error("SAP SOAP request returned HTTP 401")
  }
  await assert.rejects(
    readConfigurationFiDependencies(allFields, "009", h.backend, h.readers),
    /AUTHENTICATION_REJECTED/
  )
  assert.deepEqual(h.calls.slice(4), ["401"])
})
