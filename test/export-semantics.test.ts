import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { ExportResourceInfo } from "../src/backend.js"
import { writeResourceExport } from "../src/export.js"

const exportOf = (files: Record<string, string>, source = "ZTEST"): ExportResourceInfo => ({
  connectionId: "w200",
  source,
  files: Object.entries(files).map(([relativePath, content]) => ({
    relativePath,
    sourceUri: `/sap/bc/adt/${relativePath}`,
    content
  })),
  failures: []
})

async function workspace() {
  return mkdtemp(join(tmpdir(), "abap-mcp-export-semantics-"))
}

const listing = async (root: string): Promise<string[]> => {
  const found: string[] = []
  const walk = async (dir: string, prefix: string) => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name
      if (item.isDirectory()) await walk(join(dir, item.name), relative)
      else found.push(relative)
    }
  }
  await walk(root, "")
  return found.sort()
}

// The guard used to refuse whenever the target path existed, so `mkdir <dir>` followed by a download
// failed on an empty directory and the caller was told to pass overwrite=true - a flag whose name
// implies replacing files, and which the error never explained was also needed for a folder that
// held nothing to replace (w200, 2026-09-26 09:15). These cases pin the corrected rule: refuse only
// what would actually be replaced.
test("an existing but empty target folder needs no overwrite flag", async () => {
  const root = await workspace()
  const target = join(root, "archive")
  await mkdir(target)

  const receipt = await writeResourceExport(
    exportOf({ "PROG_P/ZTEST.abap": "REPORT ztest." }),
    target
  )

  assert.match(receipt, /Files: 1/)
  assert.match(receipt, /Overwritten: 0/)
  assert.equal(await readFile(join(target, "PROG_P", "ZTEST.abap"), "utf8"), "REPORT ztest.")
})

test("unrelated files in the target folder are kept and do not require the flag", async () => {
  const root = await workspace()
  const target = join(root, "archive")
  await mkdir(target)
  await writeFile(join(target, "SENTINEL_NOT_FROM_SAP.txt"), "hand written")

  const receipt = await writeResourceExport(
    exportOf({ "PROG_P/ZTEST.abap": "REPORT ztest." }),
    target
  )

  assert.match(receipt, /Overwritten: 0/)
  assert.equal(await readFile(join(target, "SENTINEL_NOT_FROM_SAP.txt"), "utf8"), "hand written")
  assert.deepEqual(await listing(target), ["PROG_P/ZTEST.abap", "SENTINEL_NOT_FROM_SAP.txt"])
})

test("a colliding file refuses the export and leaves the folder untouched", async () => {
  const root = await workspace()
  const target = join(root, "archive")
  await mkdir(join(target, "PROG_P"), { recursive: true })
  await writeFile(join(target, "PROG_P", "ZTEST.abap"), "local correction")

  await assert.rejects(
    writeResourceExport(
      exportOf({ "PROG_P/ZTEST.abap": "REPORT ztest.", "PROG_P/ZOTHER.abap": "REPORT zother." }),
      target
    ),
    /would replace: PROG_P\/ZTEST\.abap/
  )
  // Decided before anything was written: the colliding file keeps its bytes and the second file,
  // which would not have collided, was not created either.
  assert.equal(await readFile(join(target, "PROG_P", "ZTEST.abap"), "utf8"), "local correction")
  assert.deepEqual(await listing(target), ["PROG_P/ZTEST.abap"])
})

test("overwrite replaces only the colliding file and reports it", async () => {
  const root = await workspace()
  const target = join(root, "archive")
  await mkdir(join(target, "PROG_P"), { recursive: true })
  await writeFile(join(target, "PROG_P", "ZTEST.abap"), "corrupted")
  await writeFile(join(target, "PROG_P", "KEEP.abap"), "keep me")

  const receipt = await writeResourceExport(
    exportOf({ "PROG_P/ZTEST.abap": "REPORT ztest." }),
    target,
    true
  )

  assert.match(receipt, /Overwritten: 1/)
  assert.match(receipt, /Overwritten files:[\s\S]*PROG_P\/ZTEST\.abap/)
  assert.equal(await readFile(join(target, "PROG_P", "ZTEST.abap"), "utf8"), "REPORT ztest.")
  assert.equal(await readFile(join(target, "PROG_P", "KEEP.abap"), "utf8"), "keep me")
})

test("a second object added to a populated folder is reported as an addition, not a replacement", async () => {
  const root = await workspace()
  const target = join(root, "archive")

  await writeResourceExport(exportOf({ "PROG_P/ZSPLIT.abap": "REPORT zsplit." }), target)
  const receipt = await writeResourceExport(
    exportOf({ "PROG_P/ZMERGE.abap": "REPORT zmerge." }),
    target,
    true
  )

  assert.match(receipt, /Overwritten: 0/)
  assert.deepEqual(await listing(target), ["PROG_P/ZMERGE.abap", "PROG_P/ZSPLIT.abap"])
})

test("a nested relative path does not escape the target folder", async () => {
  const root = await workspace()
  const target = join(root, "archive")
  await assert.rejects(
    writeResourceExport(exportOf({ "../escaped.abap": "REPORT zescaped." }), target),
    /Unsafe export path/
  )
})
