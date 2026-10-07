import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { configurationNumberRangeReadApi } from "./configuration-number-range-api.js"
import {
  attestConfigurationNumberRangeApi,
  configurationNumberRangeCommandDependencies,
  configurationNumberRangeSnapshotSchema
} from "./configuration-number-range-command.js"

export const configurationNumberRangeApiReadInputSchema = z
  .object({
    connectionId: z.literal("w200"),
    objectName: z.string().regex(/^[ZY][A-Z0-9_]{0,9}$/)
  })
  .strict()

// Whole-row output shapes and hashes observed on w200; layout drift refuses invocation.
export const configurationNumberRangeNativeTables = {
  TNRO: {
    fingerprint: "1b9ee7b110ae57c8e055e6048d6676ba76b16b893be443885682bb1953a572b2",
    fields: [
      "OBJECT",
      "DTELSOBJ",
      "NRTAB",
      "NRINTFLD",
      "NREXTFLD",
      "NRFLD",
      "NRSOBJFLD",
      "NRELEFLD",
      "YEARIND",
      "DOMLEN",
      "PERCENTAGE",
      "CODE",
      "TEXTIND",
      "NRELTXTTAB",
      "NRELTXTSOB",
      "NRELTXTELE",
      "NRELTXTTXT",
      "NRELTXTLNG",
      "BUFFER",
      "NOIVBUFFER",
      "NONRSWAP",
      "RFCDEST",
      "NRCHECKASCII"
    ]
  },
  NRIV: {
    fingerprint: "a4a8ca2622e69afb3dbb80dabd0458bb86bb658761563aedc9507ff4f5d8c105",
    fields: [
      "CLIENT",
      "OBJECT",
      "SUBOBJECT",
      "NRRANGENR",
      "TOYEAR",
      "FROMNUMBER",
      "TONUMBER",
      "NRLEVEL",
      "EXTERNIND"
    ]
  }
} as const

export async function readConfigurationNumberRangeApi(
  raw: unknown,
  client: string,
  backend: Pick<SapBackend, "callRemoteFunction">,
  readDefinition: (name: string) => Promise<unknown>,
  readTable: (name: string) => Promise<unknown>
) {
  const input = configurationNumberRangeApiReadInputSchema.parse(raw)
  if (client !== "200") throw Error("CONFIGURATION_NR_SCOPE_UNSUPPORTED")
  const attest = async () => {
    for (const [name, expected] of Object.entries(configurationNumberRangeNativeTables)) {
      const table = z
        .object({
          connectionId: z.literal("w200"),
          objectKind: z.literal("transparentTable"),
          objectName: z.literal(name),
          fingerprint: z.literal(expected.fingerprint),
          definition: z.object({ fields: z.array(z.object({ name: z.string() })) })
        })
        .safeParse(await readTable(name))
      if (
        !table.success ||
        JSON.stringify(table.data.definition.fields.map((f) => f.name)) !==
          JSON.stringify(expected.fields)
      )
        throw Error("CONFIGURATION_NR_LAYOUT_NOT_ATTESTED")
    }
    const reader = attestConfigurationNumberRangeApi(
      await readDefinition(configurationNumberRangeReadApi.functionName),
      "read"
    )
    const hash = configurationNumberRangeCommandDependencies.CALCULATE_HASH_FOR_RAW
    if (
      !z
        .object({
          functionName: z.literal("CALCULATE_HASH_FOR_RAW"),
          remoteEnabled: z.literal(false),
          updateTask: z.literal(false),
          sourceFingerprint: z.literal(hash.sourceFingerprint),
          interfaceFingerprint: z.literal(hash.interfaceFingerprint)
        })
        .safeParse(await readDefinition("CALCULATE_HASH_FOR_RAW")).success
    )
      throw Error("CONFIGURATION_NR_DEPENDENCY_NOT_ATTESTED")
    return { source: reader.sourceFingerprint, interface: reader.interfaceFingerprint }
  }
  const before = await attest()
  const response = await backend.callRemoteFunction("w200", {
    functionName: configurationNumberRangeReadApi.functionName,
    // w200 SOAP returns this TABLES parameter only when the empty table is bound.
    inputParameters: { IV_OBJECT: input.objectName, ET_INTERVALS: [] },
    outputParameters: [
      ...["EV_CODE", "EV_SYSTEM", "EV_CLIENT", "EV_VERSION"].map((name) => ({
        name,
        kind: "scalar" as const
      })),
      {
        name: "ES_DEFINITION",
        kind: "structure",
        fields: [...configurationNumberRangeNativeTables.TNRO.fields]
      },
      {
        name: "ET_INTERVALS",
        kind: "table",
        fields: [...configurationNumberRangeNativeTables.NRIV.fields]
      }
    ]
  })
  if (response.fault) throw Error("CONFIGURATION_NR_READ_FAULT")
  if (response.outputs.EV_CODE !== "READ_OK") {
    const code = z
      .enum([
        "SCOPE_UNSUPPORTED",
        "INPUT_INVALID",
        "AUTHORIZATION_DENIED",
        "OBJECT_NOT_FOUND",
        "INTERVAL_LIMIT_EXCEEDED",
        "READ_CHANGED",
        "HASH_FAILED"
      ])
      .safeParse(response.outputs.EV_CODE)
    throw Error(`CONFIGURATION_NR_READ_${code.success ? code.data : "INVALID_RESPONSE"}`)
  }
  const snapshot = configurationNumberRangeSnapshotSchema.parse(response.outputs)
  if (
    snapshot.ES_DEFINITION.OBJECT !== input.objectName ||
    JSON.stringify(Object.keys(snapshot.ES_DEFINITION).sort()) !==
      JSON.stringify([...configurationNumberRangeNativeTables.TNRO.fields].sort()) ||
    snapshot.ET_INTERVALS.some(
      (row) => row.CLIENT?.trimEnd() !== "200" || row.OBJECT?.trimEnd() !== input.objectName
    )
  )
    throw Error("CONFIGURATION_NR_READ_SCOPE_INVALID")
  if (JSON.stringify(await attest()) !== JSON.stringify(before))
    throw Error("CONFIGURATION_NR_SOURCE_CHANGED")
  return {
    connectionId: input.connectionId,
    objectName: input.objectName,
    readOnly: true,
    versionScope: "complete_TNRO_and_current_client_NRIV",
    snapshot
  }
}
