import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const endpoint = new URL(process.env.ABAP_MCP_ENDPOINT || "http://127.0.0.1:4847/mcp")
const connectionId = process.env.ABAP_MCP_CONNECTION || "w200"
const writeEnabled = process.env.ABAP_MCP_DDIC_WRITE === "1"
const client = new Client({ name: "w200-ddic-wave-probe", version: "0.14.0" })

function output(result) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

async function call(name, args, expectError = false) {
  const result = await client.callTool({ name, arguments: { connectionId, ...args } })
  const text = output(result)
  if (expectError) {
    if (!result.isError) throw new Error(`${name} unexpectedly succeeded`)
    return text
  }
  if (result.isError) throw new Error(`${name}: ${text}`)
  return text
}

async function read(name, objectName) {
  return JSON.parse(await call(name, { objectName }))
}

async function currentVersion(name, objectName) {
  try {
    return (await read(name, objectName)).version
  } catch {
    return undefined
  }
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint))
  const standards = {
    domain: await read("read_ddic_domain", "CHAR10"),
    dataElement: await read("read_ddic_data_element", "BAPI_MSG"),
    structure: await read("read_ddic_structure", "BAPIRET2"),
    transparentTable: await read("read_ddic_transparent_table", "T000"),
    tableType: await read("read_ddic_table_type", "BAPIRET2_T")
  }
  if (!writeEnabled) {
    console.log(
      JSON.stringify({ endpoint: endpoint.href, connectionId, writeEnabled, standards }, null, 2)
    )
    process.exitCode = 0
  } else {
    const common = { packageName: "ZABAP", transportNumber: "GR2K923421" }
    const domainInput = {
      objectName: "ZCODEX_MCP_DOM_0831",
      description: "Codex MCP DDIC test domain",
      dataType: "CHAR",
      length: 10,
      fixedValues: [
        { low: "A", description: "Active" },
        { low: "I", description: "Inactive" }
      ],
      ...common
    }
    const domainWrite = await call("upsert_ddic_domain", {
      ...domainInput,
      expectedVersion: await currentVersion("read_ddic_domain", domainInput.objectName)
    })
    const dataElementInput = {
      objectName: "ZCODEX_MCP_DE_0831",
      description: "Codex MCP DDIC test data element",
      domainName: domainInput.objectName,
      heading: "Codex value",
      short: "Value",
      medium: "Codex value",
      long: "Codex MCP test value",
      ...common
    }
    const dataElementWrite = await call("upsert_ddic_data_element", {
      ...dataElementInput,
      expectedVersion: await currentVersion("read_ddic_data_element", dataElementInput.objectName)
    })
    const structureInput = {
      objectName: "ZCODEX_MCP_STR_0831",
      description: "Codex MCP DDIC test structure",
      fields: [{ name: "VALUE", dataElement: dataElementInput.objectName }],
      ...common
    }
    const structureWrite = await call("upsert_ddic_structure", {
      ...structureInput,
      expectedVersion: await currentVersion("read_ddic_structure", structureInput.objectName)
    })
    const tableTypeInput = {
      objectName: "ZCODEX_MCP_TT_0831",
      description: "Codex MCP DDIC test table type",
      rowType: structureInput.objectName,
      ...common
    }
    const transparentTableInput = {
      objectName: "ZCMCP_TAB_0831",
      description: "Codex MCP transparent table",
      deliveryClass: "A",
      dataClass: "APPL0",
      dataBrowserMaintenance: "notAllowed",
      sizeCategory: 0,
      fields: [
        { name: "MANDT", dataElement: "MANDT", key: true },
        { name: "VALUE", dataElement: dataElementInput.objectName, key: true },
        { name: "MESSAGE", dataElement: "BAPI_MSG" }
      ],
      ...common
    }
    let transparentTableWrite = "Existing validated table retained"
    const existingTransparentTable = await currentVersion(
      "read_ddic_transparent_table",
      transparentTableInput.objectName
    )
    if (!existingTransparentTable) {
      transparentTableWrite = await call("create_ddic_transparent_table", transparentTableInput)
    }
    const tableTypeWrite = await call("upsert_ddic_table_type", {
      ...tableTypeInput,
      expectedVersion: await currentVersion("read_ddic_table_type", tableTypeInput.objectName)
    })
    const created = {
      domain: await read("read_ddic_domain", domainInput.objectName),
      dataElement: await read("read_ddic_data_element", dataElementInput.objectName),
      structure: await read("read_ddic_structure", structureInput.objectName),
      transparentTable: await read("read_ddic_transparent_table", transparentTableInput.objectName),
      tableType: await read("read_ddic_table_type", tableTypeInput.objectName)
    }
    for (const value of Object.values(created)) {
      if (value.packageName !== "ZABAP" || !/^\d{14}$/.test(value.version)) {
        throw new Error(`DDIC re-read verification failed for ${value.objectName}`)
      }
    }
    const rejected = {
      standardWrite: await call(
        "upsert_ddic_domain",
        { ...domainInput, objectName: "CHAR10" },
        true
      ),
      missingTransport: await call(
        "upsert_ddic_domain",
        { ...domainInput, objectName: "ZCODEX_MCP_DOM_MISSING", transportNumber: "" },
        true
      ),
      duplicateField: await call(
        "upsert_ddic_structure",
        {
          ...structureInput,
          fields: [
            { name: "VALUE", dataElement: dataElementInput.objectName },
            { name: "value", dataElement: dataElementInput.objectName }
          ]
        },
        true
      ),
      versionConflict: await call(
        "upsert_ddic_domain",
        { ...domainInput, expectedVersion: "20000101000000" },
        true
      ),
      existingTableCreate: await call("create_ddic_transparent_table", transparentTableInput, true)
    }
    console.log(
      JSON.stringify(
        {
          endpoint: endpoint.href,
          connectionId,
          writeEnabled,
          standards,
          writes: {
            domainWrite,
            dataElementWrite,
            structureWrite,
            transparentTableWrite,
            tableTypeWrite
          },
          created,
          rejected
        },
        null,
        2
      )
    )
  }
} finally {
  await client.close()
}
