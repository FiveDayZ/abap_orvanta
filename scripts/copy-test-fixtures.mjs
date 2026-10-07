// `tsc` compiles `test/**/*.ts` into `dist/test/`, but it never carries the JSON fixtures those
// tests read. Each fixture is resolved relative to the compiled file, as
// `readFileSync(new URL("./fixtures/<name>.json", import.meta.url))`, so without this step
// `dist/test/fixtures/` stays empty and every configuration test fails with ENOENT while the
// fixture sits present in the source tree.
//
// The production package deliberately excludes `dist/test` (`test/package-smoke.ps1` asserts that
// compiled tests must not ship), so copying here changes nothing about what is released.
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const sourceDirectory = join(repositoryRoot, "test", "fixtures")
const targetDirectory = join(repositoryRoot, "dist", "test", "fixtures")

if (!existsSync(sourceDirectory)) {
  console.log("test fixtures: no test/fixtures directory to copy")
  process.exit(0)
}

mkdirSync(targetDirectory, { recursive: true })

let copied = 0
for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
  if (!entry.isFile()) continue
  cpSync(join(sourceDirectory, entry.name), join(targetDirectory, entry.name))
  copied += 1
}

console.log(`test fixtures: copied ${copied} file(s) into dist/test/fixtures`)
