import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const windowsOnly = process.platform === "win32" ? false : "Windows launchers require Windows"
const roots = ["ABAP_MCP_STATE_DIR", "ABAP_MCP_EXPORT_ROOT", "ABAP_MCP_NUMBER_RANGE_STATE_ROOT"]
const entry = `
import { writeFileSync } from "node:fs";
const keys = ${JSON.stringify([...roots, "ABAP_MCP_TOOL_PROFILE"])};
writeFileSync(process.env.ORVANTA_LAUNCHER_TEST_CAPTURE,
  JSON.stringify(Object.fromEntries(keys.map(key => [key, process.env[key]]))));
if (process.argv[1].endsWith("settings-index.js"))
  console.log(JSON.stringify({url: "http://127.0.0.1:49111/#" + "0".repeat(64)}));
`

for (const launcher of ["start.ps1", "open-settings.ps1"]) {
  for (const inheritedExport of [true, false]) {
    test(
      `${launcher} ${inheritedExport ? "preserves explicit" : "defaults unset"} export root`,
      {
        skip: windowsOnly
      },
      () => {
        const root = mkdtempSync(join(tmpdir(), "orvanta-launcher-state-"))
        const source = join(root, "app", "dist", "src")
        mkdirSync(source, { recursive: true })
        symlinkSync(dirname(process.execPath), join(root, "runtime"), "junction")
        copyFileSync(join(project, "packaging", "windows", launcher), join(root, launcher))
        for (const name of ["index.js", "settings-index.js"])
          writeFileSync(join(source, name), entry)
        writeFileSync(join(root, "app", "package.json"), JSON.stringify({ type: "module" }))
        writeFileSync(
          join(root, "connections.json"),
          JSON.stringify({
            connections: [
              {
                id: "local",
                username: "VALIDATION",
                passwordEnv: "ORVANTA_LAUNCHER_TEST_PASSWORD"
              }
            ]
          })
        )
        const environment = {}
        for (const name of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP"])
          if (process.env[name] !== undefined) environment[name] = process.env[name]
        Object.assign(environment, {
          ABAP_MCP_STATE_DIR: join(root, "shared history", "receipts"),
          ABAP_MCP_NUMBER_RANGE_STATE_ROOT: join(root, "shared history", "number state"),
          ABAP_MCP_TOOL_PROFILE: "full",
          ORVANTA_LAUNCHER_TEST_CAPTURE: join(root, "child-state.json"),
          ORVANTA_LAUNCHER_TEST_PASSWORD: "local-test-only"
        })
        if (inheritedExport)
          environment.ABAP_MCP_EXPORT_ROOT = join(root, "shared history", "bc exports")
        const settings = launcher === "open-settings.ps1"
        const result = spawnSync(
          settings ? "powershell.exe" : "pwsh.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            join(root, launcher),
            settings ? "-NoBrowser" : "-PassThru"
          ],
          {
            cwd: root,
            env: environment,
            encoding: "utf8",
            windowsHide: true,
            timeout: 30000
          }
        )
        assert.ifError(result.error)
        assert.equal(result.status, 0, result.stderr)
        const actual = JSON.parse(readFileSync(environment.ORVANTA_LAUNCHER_TEST_CAPTURE, "utf8"))
        for (const name of [roots[0], roots[2], "ABAP_MCP_TOOL_PROFILE"])
          assert.equal(actual[name], environment[name])
        assert.equal(
          actual.ABAP_MCP_EXPORT_ROOT,
          inheritedExport ? environment.ABAP_MCP_EXPORT_ROOT : join(root, "exports")
        )
      }
    )
  }
}
