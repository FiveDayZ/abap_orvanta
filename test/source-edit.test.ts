import assert from "node:assert/strict"
import test from "node:test"
import { findAndReplaceSource, sameSourceText } from "../src/source-edit.js"

for (const normalize of [false, true]) {
  test(`source replacement preserves literal dollar tokens (normalize=${normalize})`, () => {
    const source = "FUNCTION ztest.\r\nold\r\nbody\r\nENDFUNCTION."
    const old = normalize ? "old\nbody" : "old\r\nbody"
    const replacement = "FIND REGEX '^[0-9]+$' IN input.\n* $$ $& $` $' $1 $<name>"
    assert.equal(
      findAndReplaceSource(source, old, replacement),
      "FUNCTION ztest.\r\n" + replacement.replaceAll("\n", "\r\n") + "\r\nENDFUNCTION."
    )
  })
}

// A caller writes `\n` (the natural JSON form) and SAP stores CRLF. The candidate must therefore be
// normalized to the file's convention *before* it is fingerprinted, or the read-back compares the
// caller's line endings against SAP's and reports a failed write for an operation that succeeded -
// the multi-line false negative of w200, 2026-09-26 09:55, where appending a second INCLUDE line
// returned ACTIVE_SOURCE_FINGERPRINT_MISMATCH although the active source already held both lines.
// The exact-match path used to insert the replacement verbatim while the normalized path converted
// it, so single-line replacements worked and multi-line ones always failed.
test("an exact-match multi-line insertion adopts the source's CRLF convention", () => {
  const source = "REPORT zprobe.\r\n\r\nINCLUDE zprobe_inc.\r\n"
  const replaced = findAndReplaceSource(
    source,
    "INCLUDE zprobe_inc.",
    "INCLUDE zprobe_inc.\nINCLUDE zprobe_inc2."
  )

  assert.equal(replaced, "REPORT zprobe.\r\n\r\nINCLUDE zprobe_inc.\r\nINCLUDE zprobe_inc2.\r\n")
  assert.ok(!/(?<!\r)\n/.test(replaced), "no bare LF may survive into a CRLF document")
  // The fingerprint the service computes now equals the one SAP will produce for the stored source.
  assert.ok(sameSourceText(replaced, replaced.replaceAll("\r\n", "\n")))
})

test("a mixed-line-ending document still gets one convention", () => {
  const source = "A\r\nB"
  assert.equal(findAndReplaceSource(source, "B", "B\nC\r\nD"), "A\r\nB\r\nC\r\nD")
})

test("an LF-only document keeps LF line endings", () => {
  assert.equal(findAndReplaceSource("A\nB", "B", "B\nC"), "A\nB\nC")
})

test("sameSourceText treats line endings as equivalent and nothing else", () => {
  assert.equal(sameSourceText("A\r\nB", "A\nB"), true)
  assert.equal(sameSourceText("A\r\nB", "A\r\nB "), false)
  assert.equal(sameSourceText("A\r\nB", "A\r\nC"), false)
})
