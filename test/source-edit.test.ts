import assert from "node:assert/strict"
import test from "node:test"
import { findAndReplaceSource } from "../src/source-edit.js"

for (const normalize of [false, true]) {
  test(`source replacement preserves literal dollar tokens (normalize=${normalize})`, () => {
    const source = "FUNCTION ztest.\r\nold\r\nbody\r\nENDFUNCTION."
    const old = normalize ? "old\nbody" : "old\r\nbody"
    const replacement = "FIND REGEX '^[0-9]+$' IN input.\n* $$ $& $` $' $1 $<name>"
    assert.equal(
      findAndReplaceSource(source, old, replacement),
      "FUNCTION ztest.\r\n" +
        (normalize ? replacement.replaceAll("\n", "\r\n") : replacement) +
        "\r\nENDFUNCTION."
    )
  })
}
