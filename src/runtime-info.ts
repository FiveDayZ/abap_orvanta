import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { PRODUCT_VERSION } from "./version.js"

interface ArtifactIdentity {
  status: "observed" | "unavailable"
  observedAt: string
  artifactFingerprint?: string
  packageVersion?: string
  fileCount?: number
}

export class RuntimeIdentity {
  readonly startedAt = new Date().toISOString()
  private readonly startup: Promise<ArtifactIdentity>

  constructor(
    private readonly codeDirectory = dirname(fileURLToPath(import.meta.url)),
    readonly moduleVersion = PRODUCT_VERSION
  ) {
    this.startup = this.observe()
  }

  async report(
    expected: {
      expectedVersion?: string | undefined
      expectedArtifactFingerprint?: string | undefined
    } = {}
  ) {
    const startup = await this.startup
    const current = await this.observe()
    const checks = {
      expectedVersion:
        expected.expectedVersion === undefined
          ? "not_requested"
          : expected.expectedVersion === this.moduleVersion
            ? "match"
            : "mismatch",
      expectedArtifact:
        expected.expectedArtifactFingerprint === undefined
          ? "not_requested"
          : !startup.artifactFingerprint
            ? "unknown"
            : expected.expectedArtifactFingerprint.toLowerCase() === startup.artifactFingerprint
              ? "match"
              : "mismatch",
      diskSinceStartup:
        !startup.artifactFingerprint || !current.artifactFingerprint
          ? "unknown"
          : startup.artifactFingerprint === current.artifactFingerprint
            ? "match"
            : "mismatch",
      moduleAndPackageVersion: !current.packageVersion
        ? "unknown"
        : current.packageVersion === this.moduleVersion
          ? "match"
          : "mismatch"
    }
    return {
      status: Object.values(checks).includes("mismatch")
        ? "mismatch"
        : Object.values(checks).includes("unknown")
          ? "unavailable"
          : "observed",
      readOnly: true,
      server: { name: "orvanta", version: this.moduleVersion },
      startedAt: this.startedAt,
      nodeVersion: process.versions.node,
      startupArtifact: startup,
      currentDiskArtifact: current,
      checks,
      restartRequired:
        checks.diskSinceStartup === "mismatch" || checks.moduleAndPackageVersion === "mismatch",
      sapStatus: "not_probed",
      helperStatus: "not_probed; use get_capability_report for separately authorized observations",
      limitations: [
        "Fingerprint covers service code, package.json and package-lock.json, not every dependency or UI asset.",
        "Startup disk observation is not an attestation of every module already loaded in memory.",
        "Matching artifacts do not prove SAP connectivity, helper compatibility or runtime acceptance.",
        "No service switch, state cleanup, SAP retry or rollback is performed."
      ]
    }
  }

  private async observe(): Promise<ArtifactIdentity> {
    const observedAt = new Date().toISOString()
    try {
      const files = (await readdir(this.codeDirectory))
        .filter((name) => /\.(?:js|ts)$/.test(name) && !name.endsWith(".d.ts"))
        .sort()
      if (!files.length || files.length > 500) throw new Error("Unexpected code inventory")
      const packageRoot = resolve(
        this.codeDirectory,
        basename(dirname(this.codeDirectory)) === "dist" ? "../.." : ".."
      )
      const entries: Array<[string, string]> = []
      for (const name of files) {
        entries.push([`src/${name}`, digest(await readFile(join(this.codeDirectory, name)))])
      }
      const packageBytes = await readFile(join(packageRoot, "package.json"))
      const metadata = JSON.parse(packageBytes.toString("utf8"))
      if (typeof metadata.version !== "string") throw new Error("Missing package version")
      entries.push(["package.json", digest(packageBytes)])
      entries.push([
        "package-lock.json",
        digest(await readFile(join(packageRoot, "package-lock.json")))
      ])
      return {
        status: "observed",
        observedAt,
        packageVersion: metadata.version,
        artifactFingerprint: digest(Buffer.from(JSON.stringify(entries))),
        fileCount: entries.length
      }
    } catch {
      return { status: "unavailable", observedAt }
    }
  }
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}
