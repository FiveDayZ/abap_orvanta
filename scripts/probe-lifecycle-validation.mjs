import { randomUUID } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const endpoint = new URL(process.env.ABAP_MCP_ENDPOINT || "http://127.0.0.1:4847/mcp")
const connectionId = (process.env.ABAP_MCP_CONNECTION || "w200").toLowerCase()
const packageName = "ZABAP"
const transportNumber = "GR2K923421"
const phase = process.env.ABAP_MCP_LIFECYCLE_PHASE || "all"
const client = new Client({ name: "w200-lifecycle-validation", version: "0.30.2" })
const createdSource = []
const createdDdic = []
const evidence = {
  productVersion: "0.30.2",
  endpoint: endpoint.href,
  connectionId,
  phase,
  packageName,
  transportNumber,
  status: "failed",
  source: {},
  ddic: {},
  cleanup: []
}

if (process.env.ABAP_MCP_LIFECYCLE_ACCEPTED !== "1") {
  throw new Error("ABAP_MCP_LIFECYCLE_ACCEPTED=1 is required")
}
if (!["source", "source-cleanup", "ddic", "all"].includes(phase)) {
  throw new Error(`Unsupported phase: ${phase}`)
}

const sourceTargets = [
  { objectType: "CLAS/OC", objectName: "ZCL_CMCP_0301", searchType: "CLAS" },
  { objectType: "INTF/OI", objectName: "ZIF_CMCP_0301", searchType: "INTF" },
  { objectType: "PROG/P", objectName: "ZCMCP_PRG_0301", searchType: "PROG" },
  { objectType: "PROG/I", objectName: "ZCMCP_I_0301", searchType: "PROG" },
  { objectType: "FUGR/F", objectName: "ZCMCP_FG_0301", searchType: "FUGR" },
  {
    objectType: "FUGR/I",
    objectName: "F01",
    technicalName: "LZCMCP_FG_0301F01",
    parentName: "ZCMCP_FG_0301",
    searchType: "PROG"
  },
  {
    objectType: "FUGR/FF",
    objectName: "ZCMCP_FM_0301",
    parentName: "ZCMCP_FG_0301",
    searchType: "FUNC"
  }
]
const ddicTargets = [
  { objectType: "DOMA", objectName: "ZCMCP_DOM_0301", readTool: "read_ddic_domain" },
  { objectType: "DTEL", objectName: "ZCMCP_DE_0301", readTool: "read_ddic_data_element" },
  { objectType: "STRU", objectName: "ZCMCP_STR_0301", readTool: "read_ddic_structure" },
  { objectType: "TTYP", objectName: "ZCMCP_TT_0301", readTool: "read_ddic_table_type" }
]

function textOutput(result) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

async function callRaw(name, args) {
  return client.callTool({ name, arguments: { connectionId, ...args } })
}

async function call(name, args) {
  const result = await callRaw(name, args)
  const text = textOutput(result)
  if (result.isError) throw new Error(`${name}: ${text}`)
  return text
}

function operationId(action) {
  return `l302-${action.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 20)}-${randomUUID()}`
}

function businessText(text) {
  return text.split("\nOperation Receipt\n", 1)[0].trim()
}

function parseJson(text) {
  return JSON.parse(businessText(text))
}

function fingerprintFromSource(text) {
  const value = text.match(/^Full Source SHA-256: ([a-f0-9]{64})$/im)?.[1]
  if (!value) throw new Error(`Full source fingerprint missing: ${text}`)
  return value.toLowerCase()
}

async function sourceExists(target) {
  const result = await callRaw("search_abap_objects", {
    pattern: target.technicalName || target.objectName,
    types: [target.searchType],
    maxResults: 5
  })
  const text = textOutput(result)
  if (result.isError) throw new Error(`search_abap_objects: ${text}`)
  return !/^No ABAP objects found/im.test(text)
}

async function readSourceFingerprint(target) {
  const text = await call("get_abap_object_lines", {
    objectName: target.technicalName || target.objectName,
    objectType: target.searchType,
    startLine: 1,
    lineCount: 5000
  })
  return fingerprintFromSource(text)
}

async function deleteSource(target, expectedFingerprint, cleanup = false) {
  const result = await call("delete_abap_source_object", {
    objectType: target.objectType,
    objectName: target.objectName,
    ...(target.parentName ? { parentName: target.parentName } : {}),
    expectedFingerprint,
    packageName,
    transportNumber,
    confirmation: "PERMANENT_DELETE",
    operationId: operationId(
      cleanup ? `cleanup-${target.objectName}` : `delete-${target.objectName}`
    )
  })
  const payload = parseJson(result)
  if (!payload.absenceVerified || payload.preDeleteFingerprint !== expectedFingerprint) {
    throw new Error(`Source deletion verification failed for ${target.objectName}`)
  }
  return payload
}

async function readDdic(target) {
  return JSON.parse(await call(target.readTool, { objectName: target.objectName }))
}

async function deleteDdic(target, version, cleanup = false) {
  const result = await call("delete_ddic_object", {
    objectType: target.objectType,
    objectName: target.objectName,
    expectedVersion: version,
    packageName,
    transportNumber,
    confirmation: "PERMANENT_DELETE",
    operationId: operationId(
      cleanup ? `cleanup-${target.objectName}` : `delete-${target.objectName}`
    )
  })
  const payload = parseJson(result)
  if (!payload.absenceVerified)
    throw new Error(`DDIC deletion verification failed for ${target.objectName}`)
  return payload
}

async function requireApprovedTargetsAbsent() {
  if (phase === "source" || phase === "all") {
    for (const target of sourceTargets) {
      if (await sourceExists(target))
        throw new Error(`${target.technicalName || target.objectName} already exists`)
    }
  }
  if (phase === "ddic" || phase === "all") {
    for (const target of ddicTargets) {
      const result = await callRaw(target.readTool, { objectName: target.objectName })
      if (!result.isError) throw new Error(`${target.objectName} already exists`)
    }
  }
}

async function validateSourceLifecycle() {
  const transportRequest = { type: "existing", number: transportNumber }
  const create = async (objectType, name, description, parentName) => {
    await call("create_object_programmatically", {
      objectType,
      name,
      description,
      packageName,
      ...(parentName ? { parentName } : {}),
      additionalOptions: { transportRequest },
      operationId: operationId(`create-${name}`)
    })
    const target = sourceTargets.find(
      (candidate) => candidate.objectType === objectType && candidate.objectName === name
    )
    if (!target) throw new Error(`Unknown source target ${objectType} ${name}`)
    createdSource.push(target)
  }

  await create("CLAS/OC", "ZCL_CMCP_0301", "MCP lifecycle class")
  await create("INTF/OI", "ZIF_CMCP_0301", "MCP lifecycle interface")
  await create("PROG/P", "ZCMCP_PRG_0301", "MCP lifecycle program")
  await create("PROG/I", "ZCMCP_I_0301", "MCP lifecycle include")
  await create("FUGR/F", "ZCMCP_FG_0301", "MCP lifecycle function group")
  await create("FUGR/I", "F01", "MCP lifecycle function include", "ZCMCP_FG_0301")
  await call("create_function_module_with_interface", {
    functionName: "ZCMCP_FM_0301",
    functionGroup: "ZCMCP_FG_0301",
    description: "MCP lifecycle function",
    remoteEnabled: false,
    importParameters: [{ name: "IV_INPUT", typeName: "CHAR20", passByValue: true }],
    exportParameters: [{ name: "EV_OUTPUT", typeName: "CHAR20", passByValue: true }],
    changingParameters: [],
    tableParameters: [],
    exceptions: [],
    source: ["  ev_output = iv_input."],
    packageName,
    transportNumber,
    operationId: operationId("create-ZCMCP_FM_0301")
  })
  createdSource.push(sourceTargets[6])

  const fingerprints = {}
  for (const target of sourceTargets) {
    fingerprints[target.objectName] = await readSourceFingerprint(target)
  }

  const stale = await callRaw("delete_abap_source_object", {
    objectType: "PROG/P",
    objectName: "ZCMCP_PRG_0301",
    expectedFingerprint: "f".repeat(64),
    packageName,
    transportNumber,
    confirmation: "PERMANENT_DELETE",
    operationId: operationId("reject-stale-program")
  })
  const staleText = textOutput(stale)
  if (!stale.isError || !/SOURCE_FINGERPRINT_CONFLICT/.test(staleText)) {
    throw new Error(`Stale source fingerprint was not rejected: ${staleText}`)
  }
  if (!(await sourceExists(sourceTargets[2])))
    throw new Error("Stale rejection deleted the program")

  const deleted = []
  for (const target of [...sourceTargets].reverse()) {
    deleted.push(await deleteSource(target, fingerprints[target.objectName]))
    createdSource.splice(createdSource.indexOf(target), 1)
  }
  evidence.source = { fingerprints, staleFingerprintRejected: true, deleted }
}

async function validateDdicLifecycle() {
  await call("upsert_ddic_domain", {
    objectName: "ZCMCP_DOM_0301",
    description: "MCP lifecycle domain",
    packageName,
    transportNumber,
    dataType: "CHAR",
    length: 10,
    lowercase: false,
    signFlag: false,
    fixedValues: [
      { low: "A", description: "Active" },
      { low: "I", description: "Inactive" }
    ],
    operationId: operationId("create-domain")
  })
  createdDdic.push(ddicTargets[0])
  await call("upsert_ddic_data_element", {
    objectName: "ZCMCP_DE_0301",
    description: "MCP lifecycle element",
    domainName: "ZCMCP_DOM_0301",
    heading: "Lifecycle value",
    short: "Value",
    medium: "Lifecycle value",
    long: "Lifecycle validation value",
    packageName,
    transportNumber,
    operationId: operationId("create-data-element")
  })
  createdDdic.push(ddicTargets[1])
  await call("upsert_ddic_structure", {
    objectName: "ZCMCP_STR_0301",
    description: "MCP lifecycle structure",
    fields: [{ name: "VALUE", dataElement: "ZCMCP_DE_0301" }],
    packageName,
    transportNumber,
    operationId: operationId("create-structure")
  })
  createdDdic.push(ddicTargets[2])
  await call("upsert_ddic_table_type", {
    objectName: "ZCMCP_TT_0301",
    description: "MCP lifecycle table type",
    rowType: "ZCMCP_STR_0301",
    packageName,
    transportNumber,
    operationId: operationId("create-table-type")
  })
  createdDdic.push(ddicTargets[3])

  const definitions = {}
  for (const target of ddicTargets) definitions[target.objectName] = await readDdic(target)

  const dependencyResult = await callRaw("delete_ddic_object", {
    objectType: "DOMA",
    objectName: "ZCMCP_DOM_0301",
    expectedVersion: definitions.ZCMCP_DOM_0301.version,
    packageName,
    transportNumber,
    confirmation: "PERMANENT_DELETE",
    operationId: operationId("reject-domain-dependency")
  })
  const dependencyText = textOutput(dependencyResult)
  if (!dependencyResult.isError || !/DEPENDENC|REFERENC/i.test(dependencyText)) {
    throw new Error(`DDIC dependency was not rejected: ${dependencyText}`)
  }

  const deleted = []
  for (const target of [...ddicTargets].reverse()) {
    const current = await readDdic(target)
    deleted.push(await deleteDdic(target, current.version))
    createdDdic.splice(createdDdic.indexOf(target), 1)
  }
  evidence.ddic = { definitions, dependencyRejected: true, deleted }
}

async function cleanupResiduals() {
  for (const target of [...createdSource].reverse()) {
    try {
      if (!(await sourceExists(target))) continue
      const fingerprint = await readSourceFingerprint(target)
      await deleteSource(target, fingerprint, true)
      evidence.cleanup.push({
        target: target.technicalName || target.objectName,
        status: "deleted"
      })
    } catch (error) {
      evidence.cleanup.push({
        target: target.technicalName || target.objectName,
        status: "failed",
        error: String(error)
      })
    }
  }
  for (const target of [...createdDdic].reverse()) {
    try {
      const current = await readDdic(target)
      await deleteDdic(target, current.version, true)
      evidence.cleanup.push({ target: target.objectName, status: "deleted" })
    } catch (error) {
      evidence.cleanup.push({ target: target.objectName, status: "failed", error: String(error) })
    }
  }
}

let primaryError
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  if (phase === "source-cleanup") {
    for (const target of sourceTargets) {
      if (await sourceExists(target)) createdSource.push(target)
    }
  } else {
    await requireApprovedTargetsAbsent()
    if (phase === "source" || phase === "all") await validateSourceLifecycle()
    if (phase === "ddic" || phase === "all") await validateDdicLifecycle()
  }
  evidence.status = "passed"
} catch (error) {
  primaryError = error
  evidence.error = String(error)
} finally {
  await cleanupResiduals()
  evidence.cleanupComplete = evidence.cleanup.every((item) => item.status === "deleted")
  await client.close()
}

console.log(JSON.stringify(evidence, null, 2))
if (primaryError || !evidence.cleanupComplete) process.exitCode = 1
