#!/usr/bin/env node
// Build an additive local candidate; never rebuild shared dist or prune older artifacts.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
assert.equal(
  args.length,
  4,
  "Usage: node scripts/package-spro-core.mjs <new-output> <node-root> <persistent-state> <port>"
)
const [outputArg, nodeArg, stateArg, portArg] = args
const output = resolve(outputArg)
const nodeRoot = resolve(nodeArg)
const stateRoot = resolve(stateArg)
const port = Number(portArg)
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, "Invalid loopback port")
assert.ok(!/[\r\n']/.test(output + stateRoot), "Unsupported path characters")
const stateRelative = relative(output, stateRoot)
assert.ok(
  stateRelative === ".." || stateRelative.startsWith(".." + sep) || isAbsolute(stateRelative),
  "State must live outside the candidate"
)
const metadata = JSON.parse(await readFile(join(project, "package.json"), "utf8"))
const lock = JSON.parse(await readFile(join(project, "package-lock.json"), "utf8"))
assert.equal(lock.version, metadata.version)
assert.equal(lock.packages[""].version, metadata.version)
const delivery = JSON.parse(
  await readFile(join(project, "contracts/spro-core-delivery.json"), "utf8")
)
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
async function inventory(root) {
  const entries = {}
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      assert.ok(!entry.isSymbolicLink(), "Candidate inputs must not contain symlinks")
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else entries[relative(root, path).replaceAll("\\", "/")] = hash(await readFile(path))
    }
  }
  await walk(root)
  return entries
}
async function command(executable, arguments_, cwd) {
  await new Promise((done, reject) => {
    const child = spawn(executable, arguments_, { cwd, stdio: "inherit", windowsHide: true })
    child.once("error", reject)
    child.once("exit", (code) =>
      code === 0 ? done() : reject(Error(`Candidate preparation failed (exit ${code})`))
    )
  })
}
const sourceBefore = await inventory(join(project, "src"))
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: project,
  encoding: "utf8",
  windowsHide: true
}).trim()
const sourceBranch = execFileSync("git", ["branch", "--show-current"], {
  cwd: project,
  encoding: "utf8",
  windowsHide: true
}).trim()
const sourceDirty =
  execFileSync("git", ["status", "--porcelain"], {
    cwd: project,
    encoding: "utf8",
    windowsHide: true
  }).trim().length > 0
// Exclusive mkdir is intentional: on failure retain every partial artifact for diagnosis.
await mkdir(output)
const app = join(output, "app")
await mkdir(app)
await cp(join(project, "package.json"), join(app, "package.json"))
await cp(join(project, "package-lock.json"), join(app, "package-lock.json"))
await writeFile(
  join(output, "tsconfig.candidate.json"),
  JSON.stringify({
    extends: join(project, "tsconfig.json"),
    compilerOptions: { rootDir: project, outDir: join(app, "dist") },
    include: [join(project, "src").replaceAll("\\", "/") + "/**/*.ts"]
  }),
  { flag: "wx" }
)
await command(
  process.execPath,
  [join(project, "node_modules/typescript/bin/tsc"), "-p", join(output, "tsconfig.candidate.json")],
  project
)
assert.deepEqual(
  await inventory(join(project, "src")),
  sourceBefore,
  "Source changed during candidate compilation"
)
// npm's existing lock and cache supply production dependencies; no scripts or network.
const npmRoot = dirname(process.execPath)
const npmCli = join(npmRoot, "node_modules/npm/bin/npm-cli.js")
await command(
  process.execPath,
  [npmCli, "ci", "--offline", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
  app
)
const runtime = join(output, "runtime")
await mkdir(runtime)
await cp(join(nodeRoot, "node.exe"), join(runtime, "node.exe"))
await cp(join(nodeRoot, "LICENSE"), join(runtime, "NODE-LICENSE.txt"))
await cp(join(project, "LICENSE"), join(output, "LICENSE"))
await cp(join(project, "contracts/spro-core-delivery.json"), join(output, "SPRO-CORE.json"))
await mkdir(join(app, "scripts"))
await cp(join(project, "scripts/check-spro-core.mjs"), join(app, "scripts/check-spro-core.mjs"))
const { TOOL_NAMES, toolNamesForProfile } = await import(
  pathToFileURL(join(app, "dist/src/tool-registry.js"))
)
assert.equal(new Set(delivery.requiredTools).size, delivery.requiredTools.length)
for (const tool of delivery.requiredTools)
  assert.ok(
    toolNamesForProfile(delivery.profile).includes(tool),
    `Missing configuration tool: ${tool}`
  )
const denied = TOOL_NAMES.filter((name) => !delivery.requiredTools.includes(name))
const factory = JSON.parse(await readFile(join(project, "connections.example.json"), "utf8"))
assert.equal(factory.connections.length, 1)
const placeholder = factory.connections[0]
assert.ok(new URL(placeholder.url).hostname.endsWith(".invalid"))
assert.equal(placeholder.username, "DEVELOPER")
assert.ok(!Object.hasOwn(placeholder, "password"))
placeholder.id = "w200"
placeholder.passwordEnv = "ABAP_MCP_W200_PASSWORD"
await writeFile(join(output, "connections.json"), JSON.stringify(factory, null, 2) + "\n", {
  flag: "wx"
})
const launch = `#requires -Version 7.0
param([ValidateRange(1024,65535)][int]$Port = ${port}, [string]$StateDirectory = '${stateRoot}')
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$env:ABAP_MCP_TOOL_PROFILE = '${delivery.profile}'
$env:ABAP_MCP_TOOL_DENY = '${denied.join(",")}'
$env:ABAP_MCP_STATE_DIR = [IO.Path]::GetFullPath($StateDirectory)
& (Join-Path $root 'start.ps1') -Port $Port -PassThru
exit $LASTEXITCODE
`
await cp(join(project, "packaging/windows/start.ps1"), join(output, "start.ps1"))
await writeFile(join(output, "start-core.ps1"), "\ufeff" + launch, { flag: "wx" })
await writeFile(
  join(output, "start-core.cmd"),
  '@echo off\r\npwsh -NoLogo -NoProfile -File "%~dp0start-core.ps1" %*\r\n',
  { flag: "wx" }
)
const { RuntimeIdentity } = await import(pathToFileURL(join(app, "dist/src/runtime-info.js")))
const identity = await new RuntimeIdentity().report()
assert.equal(identity.status, "observed", "Candidate runtime identity unavailable")
assert.equal(identity.checks.moduleAndPackageVersion, "match")
await writeFile(
  join(output, "SOURCE-INFO.json"),
  JSON.stringify(
    {
      compiledAt: new Date().toISOString(),
      sourceSha256: sourceBefore,
      sourceFingerprint: hash(JSON.stringify(sourceBefore)),
      sourceCommit,
      sourceBranch,
      dirtyCandidate: sourceDirty,
      sharedDistRebuilt: false
    },
    null,
    2
  ) + "\n",
  { flag: "wx" }
)
// Hash installed dependencies as well: runtime identity alone intentionally does not.
const files = await inventory(output)
assert.deepEqual(
  await inventory(join(project, "src")),
  sourceBefore,
  "Source changed during packaging"
)
await writeFile(
  join(output, "BUILD-INFO.json"),
  JSON.stringify(
    {
      product: metadata.name,
      version: metadata.version,
      candidate: delivery.name,
      builtAt: new Date().toISOString(),
      nodeExecutableSha256: files["runtime/node.exe"],
      expectedArtifactFingerprint: identity.startupArtifact.artifactFingerprint,
      profile: delivery.profile,
      requiredTools: delivery.requiredTools,
      defaultPort: port,
      stateRoot,
      formalServiceAcceptance: delivery.formalServiceAcceptance,
      sapAcceptance: "not_run",
      fileHashScope:
        "All candidate files including installed production dependencies, except BUILD-INFO.json and future local state/config changes.",
      fileSha256: files
    },
    null,
    2
  ) + "\n",
  { flag: "wx" }
)
console.log(
  JSON.stringify(
    {
      candidate: output,
      tools: delivery.requiredTools.length,
      expectedArtifactFingerprint: identity.startupArtifact.artifactFingerprint,
      serviceStarted: false,
      sapCalls: 0
    },
    null,
    2
  )
)
