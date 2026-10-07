import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"

// Verified in w200: S_PARA_INT_TYPEPOOL_GET reads the generated %_C<pool> program.
export const configurationBcTypePoolReadPins = {
  RPY_PROGRAM_READ: {
    source: "ca0eb64fa3caee7e49dfbe5011985576b6b2201bee1e31388eda487613ed6b46",
    interface: "8ac3a0e01c72caab33dbbb04fd7e83b5cf3ab85459513399d875c2d037174637"
  },
  RPY_PROG: "d1ef5e29561c365fe2d364d72dcd8752d7a5aa4c1bac44284733b2b6810af3c4",
  ABAPTXT255: "b3d36dacbfb3d2cd5bef0f47cad58b05eca8b5d317dc65a1dba05207626212e9"
} as const

const typePoolPath =
  /^\/sap\/bc\/adt\/vit\/wb\/object_type\/typedg\/object_name\/SCPR(?:\/source\/main)?$/i

/** Only the fixed SCPR navigation resource, never an arbitrary program name or URI fallback. */
export function isConfigurationBcTypePoolUri(uri: string): boolean {
  return typePoolPath.test(uri.replace(/^adt:\/\/[^/]+/i, ""))
}

export async function readConfigurationBcTypePool(
  connectionId: string,
  uri: string,
  backend: Pick<SapBackend, "connectionDetails" | "callRemoteFunction">,
  readers: {
    definition: () => Promise<unknown>
    structure: (name: "RPY_PROG" | "ABAPTXT255") => Promise<unknown>
  }
) {
  const uriConnection = /^adt:\/\/([^/]+)/i.exec(uri)?.[1]?.toLowerCase()
  if (
    connectionId !== "w200" ||
    (uriConnection !== undefined && uriConnection !== connectionId) ||
    !isConfigurationBcTypePoolUri(uri) ||
    backend.connectionDetails(connectionId).client !== "200"
  )
    throw Error("CONFIGURATION_BC_TYPE_POOL_SCOPE_INVALID")

  const attest = async () => {
    const result = await Promise.allSettled([
      readers.definition(),
      readers.structure("RPY_PROG"),
      readers.structure("ABAPTXT255")
    ])
    const values = result.map((item) => {
      if (item.status === "rejected") throw item.reason
      return item.value
    })
    z.object({
      connectionId: z.literal("w200"),
      functionName: z.literal("RPY_PROGRAM_READ"),
      remoteEnabled: z.literal(true),
      updateTask: z.literal(false),
      sourceFingerprint: z.literal(configurationBcTypePoolReadPins.RPY_PROGRAM_READ.source),
      interfaceFingerprint: z.literal(configurationBcTypePoolReadPins.RPY_PROGRAM_READ.interface)
    }).parse(values[0])
    for (const [index, name] of ["RPY_PROG", "ABAPTXT255"].entries())
      z.object({
        connectionId: z.literal("w200"),
        objectName: z.literal(name),
        objectKind: z.literal("structure"),
        fingerprint: z.literal(configurationBcTypePoolReadPins[name as "RPY_PROG" | "ABAPTXT255"])
      }).parse(values[index + 1])
  }
  await attest()
  const reply = await backend.callRemoteFunction("w200", {
    functionName: "RPY_PROGRAM_READ",
    inputParameters: {
      PROGRAM_NAME: "%_CSCPR",
      WITH_INCLUDELIST: "",
      ONLY_SOURCE: "X",
      ONLY_TEXTS: "",
      READ_LATEST_VERSION: "",
      WITH_LOWERCASE: "X",
      SOURCE_EXTENDED: []
    },
    outputParameters: [
      { name: "PROG_INF", kind: "structure", fields: ["PROGNAME", "PROG_TYPE"] },
      { name: "SOURCE_EXTENDED", kind: "table", fields: ["LINE"] }
    ]
  })
  if (reply.fault) throw Error("CONFIGURATION_BC_TYPE_POOL_READ_REJECTED")
  const parsed = z
    .object({
      PROG_INF: z.object({ PROGNAME: z.literal("%_CSCPR"), PROG_TYPE: z.string().min(1).max(1) }),
      SOURCE_EXTENDED: z
        .array(z.object({ LINE: z.string().max(255) }))
        .min(1)
        .max(4096)
    })
    .parse(reply.outputs)
  const lines = parsed.SOURCE_EXTENDED.map((row) => row.LINE)
  if (
    lines.some((line) => /[\r\n\u0000]/.test(line)) ||
    !lines.some((line) => /^\s*TYPE-POOL\s+SCPR\s*\./i.test(line))
  )
    throw Error("CONFIGURATION_BC_TYPE_POOL_SOURCE_INVALID")
  // No formatting or case conversion: this digest identifies the preserved RFC CHAR255 rows.
  const source = lines.join("\r\n")
  if (Buffer.byteLength(source) > 1048576) throw Error("CONFIGURATION_BC_TYPE_POOL_SOURCE_LIMIT")
  await attest()
  return {
    source,
    uriUsed: uri,
    provider: "RPY_PROGRAM_READ" as const,
    programName: "%_CSCPR" as const,
    sourceVersion: "active" as const,
    representation: "rfc_char255_rows_crlf" as const,
    sourceFingerprint: createHash("sha256").update(source).digest("hex")
  }
}
