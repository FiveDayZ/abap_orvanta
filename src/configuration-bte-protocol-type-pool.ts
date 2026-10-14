import { createHash } from "node:crypto"
import { z } from "zod"
import type { SapBackend } from "./backend.js"
import { configurationBcTypePoolReadPins } from "./configuration-bc-type-pool.js"

const sha = (value: string) => createHash("sha256").update(value).digest("hex")
const poolUri = "/sap/bc/adt/vit/wb/object_type/typedg/object_name/TRLOG"
const sourceArrayHash = "3cfecbb544d9da35e5de006135dd4109890ddf6cd983e8e7af43f0eb15e1e3cf"
const interfaceHash = "1264f80b650b37a0269e983f60099868784039351a1257884e276e76c4e6fe74"
const structures = ["RPY_PROG", "ABAPTXT255"] as const

function fail(code: string): never {
  throw Error(`BTE_PROTOCOL_TYPE_POOL_${code}`)
}

/** Fixed TRLOG source read; it cannot select another pool, program, client or source version. */
export async function readConfigurationBteProtocolTypePool(
  connectionId: string,
  uri: string,
  backend: Pick<SapBackend, "connectionDetails" | "callRemoteFunction">,
  readers: {
    definition(): Promise<unknown>
    structure(name: (typeof structures)[number]): Promise<unknown>
  }
) {
  const plainUri = uri.replace(/^adt:\/\/w200(?=\/)/, "")
  if (
    connectionId !== "w200" ||
    ![poolUri, `${poolUri}/source/main`].includes(plainUri) ||
    backend.connectionDetails(connectionId).client !== "200"
  )
    fail("SCOPE_INVALID")

  const attest = async () => {
    const results = await Promise.allSettled([
      readers.definition(),
      ...structures.map((name) => readers.structure(name))
    ])
    if (results.some((r) => r.status === "rejected")) fail("READER_UNVERIFIED")
    const values = results.map((r) => (r.status === "fulfilled" ? r.value : undefined))
    const result = z
      .object({
        connectionId: z.literal("w200"),
        functionName: z.literal("RPY_PROGRAM_READ"),
        remoteEnabled: z.literal(true),
        updateTask: z.literal(false),
        updateTaskMode: z.literal(""),
        sourceFingerprint: z.literal(configurationBcTypePoolReadPins.RPY_PROGRAM_READ.source),
        interfaceFingerprint: z.literal(configurationBcTypePoolReadPins.RPY_PROGRAM_READ.interface),
        source: z.array(z.string()),
        importParameters: z.array(z.unknown()),
        exportParameters: z.array(z.unknown()),
        changingParameters: z.array(z.unknown()),
        tableParameters: z.array(z.unknown()),
        exceptions: z.array(z.unknown())
      })
      .safeParse(values[0])
    if (!result.success) fail("READER_UNVERIFIED")
    const abi = Object.fromEntries(
      [
        "importParameters",
        "exportParameters",
        "changingParameters",
        "tableParameters",
        "exceptions"
      ].map((key) => [key, result.data[key as keyof typeof result.data]])
    )
    if (
      sha(JSON.stringify(result.data.source)) !== sourceArrayHash ||
      sha(JSON.stringify(abi)) !== interfaceHash
    )
      fail("READER_UNVERIFIED")
    for (const [index, name] of structures.entries()) {
      const parsed = z
        .object({
          connectionId: z.literal("w200"),
          objectName: z.literal(name),
          objectKind: z.literal("structure"),
          fingerprint: z.literal(configurationBcTypePoolReadPins[name]),
          definition: z.unknown()
        })
        .safeParse(values[index + 1])
      if (
        !parsed.success ||
        sha(JSON.stringify(parsed.data.definition)) !== configurationBcTypePoolReadPins[name]
      )
        fail("READER_UNVERIFIED")
    }
  }
  await attest()
  // r83's S_PARA_INT_TYPEPOOL_GET source establishes the generated %_C<pool> route.
  // RPY_PROGRAM_READ uses SHOW authorization; these flags select active, unformatted source only.
  const reply = await backend.callRemoteFunction("w200", {
    functionName: "RPY_PROGRAM_READ",
    inputParameters: {
      PROGRAM_NAME: "%_CTRLOG",
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
  if (reply.fault) fail("READ_REJECTED")
  const parsed = z
    .object({
      PROG_INF: z.object({
        PROGNAME: z.literal("%_CTRLOG"),
        PROG_TYPE: z
          .string()
          .length(1)
          .refine((value) => value.trim().length === 1)
      }),
      SOURCE_EXTENDED: z
        .array(z.object({ LINE: z.string().max(255) }))
        .min(1)
        .max(4096)
    })
    .safeParse(reply.outputs)
  if (!parsed.success) fail("RESPONSE_UNVERIFIED")
  const lines = parsed.data.SOURCE_EXTENDED.map((row) => row.LINE)
  if (
    lines.some((line) => /[\r\n\u0000]/.test(line)) ||
    !lines.some((line) => /^\s*TYPE-POOL\s+TRLOG\s*\./i.test(line))
  )
    fail("SOURCE_UNVERIFIED")
  const source = lines.join("\r\n")
  if (Buffer.byteLength(source) > 1048576) fail("SOURCE_LIMIT")
  await attest()
  return {
    source,
    uriUsed: plainUri,
    provider: "RPY_PROGRAM_READ" as const,
    programName: "%_CTRLOG" as const,
    sourceVersion: "active" as const,
    representation: "rfc_char255_rows_crlf" as const,
    sourceFingerprint: sha(source),
    lineCount: lines.length,
    nativeMessageProtocolVerified: false,
    writeAvailable: false
  }
}
