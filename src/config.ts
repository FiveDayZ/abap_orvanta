import { readFile } from "node:fs/promises"
import { z } from "zod"

const remoteFunctionName = z
  .string()
  .trim()
  .regex(/^[ZY][A-Za-z0-9_]{0,29}$/i)
  .transform((value) => value.toUpperCase())

const connectionSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_-]+$/),
  url: z.string().url(),
  client: z.string().default("000"),
  language: z.string().default("EN"),
  username: z.string().min(1),
  passwordEnv: z.string().min(1),
  allowUnauthorized: z.boolean().default(false),
  atcVariant: z.string().min(1).optional(),
  remoteFunctionAllowlist: z.array(remoteFunctionName).max(100).default([])
})

const configSchema = z.object({
  connections: z.array(connectionSchema).min(1)
})

export type ConnectionConfig = z.infer<typeof connectionSchema>

export async function loadConnections(path: string): Promise<ConnectionConfig[]> {
  const raw = await readFile(path, "utf8")
  return parseConnections(JSON.parse(raw.replace(/^\uFEFF/, "")))
}

export function parseConnections(input: unknown): ConnectionConfig[] {
  const parsed = configSchema.parse(input)
  const ids = new Set<string>()

  return parsed.connections.map((connection) => {
    const normalized = { ...connection, id: connection.id.toLowerCase() }
    if (ids.has(normalized.id)) {
      throw new Error(`Duplicate connection id: ${normalized.id}`)
    }
    if (
      new Set(normalized.remoteFunctionAllowlist).size !== normalized.remoteFunctionAllowlist.length
    ) {
      throw new Error(`Duplicate remote function in ${normalized.id} allowlist`)
    }
    ids.add(normalized.id)
    return normalized
  })
}
