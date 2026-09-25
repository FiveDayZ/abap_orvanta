/**
 * The object-type vocabulary is shared by every tool that resolves an object by name.
 *
 * The defects these tests pin down were found live on w200 (2026-09-25T00:37-00:43): the service
 * reports ADT type paths (`FUGR/FF`) while its repository search only accepts short codes (`FUNC`),
 * and `searchObjects` silently skips a type the target cannot search. Feeding a reported path back
 * therefore produced "Could not find ABAP object: ZPMC_FM_TP_STOCK_CALC. Please check the object
 * name and ensure it exists." for a function module that answered the identical call with `FUNC`.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { DEFAULT_OBJECT_TYPES } from "../src/backend.js"
import {
  FUNCTION_MODULE_TYPE_TOKENS,
  SEARCHABLE_OBJECT_TYPE_TOKENS,
  isFunctionModuleType,
  isSearchTypeCode,
  searchCodeOfAdtType,
  searchTypeCode,
  searchTypeCodes
} from "../src/object-types.js"

test("every ADT type path the service hands out translates to the search code that finds it", () => {
  const expected: Record<string, string> = {
    "FUNC/FM": "FUNC",
    "FUNC/FF": "FUNC",
    "FUGR/FF": "FUNC",
    "CLAS/OC": "CLAS",
    "INTF/OI": "INTF",
    "PROG/P": "PROG",
    "PROG/I": "PROG",
    "FUGR/I": "PROG",
    "FUGR/F": "FUGR",
    "TABL/DT": "TABL",
    "TABL/DS": "TABL"
  }
  for (const [path, code] of Object.entries(expected)) {
    assert.equal(searchTypeCode(path), code, path)
  }
  // Case and surrounding whitespace come from the caller, not from this service.
  assert.equal(searchTypeCode("  fugr/ff "), "FUNC")
})

test("a search code passes through unchanged, including one this release does not list", () => {
  for (const code of DEFAULT_OBJECT_TYPES) {
    assert.equal(searchTypeCode(code), code, code)
    assert.equal(isSearchTypeCode(code), true, code)
  }
  // A short code the caller supplies is a statement about the object, not a path this service
  // cannot search: the search itself decides. Only path-shaped tokens are refused.
  assert.equal(searchTypeCode("SMOD"), "SMOD")
  assert.equal(isSearchTypeCode("SMOD"), false)
})

test("a path-shaped type the service cannot search is refused instead of answered as not found", () => {
  assert.throws(
    () => searchTypeCode("CLAS/XX"),
    (error: Error) =>
      /UNSUPPORTED_OBJECT_TYPE/.test(error.message) &&
      /CLAS\/XX/.test(error.message) &&
      // The message must not let a refusal read as a fact about the object.
      !/does not exist/i.test(error.message)
  )
})

test("the reverse direction classifies a type SAP reported without rejecting the caller", () => {
  assert.equal(searchCodeOfAdtType("FUGR/FF"), "FUNC")
  assert.equal(searchCodeOfAdtType("PROG/I"), "PROG")
  assert.equal(searchCodeOfAdtType("TABL"), "TABL")
  assert.equal(searchCodeOfAdtType("CLAS/OC"), "CLAS")
  // Classification is by family, not by an enumerated list: SAP may report a path this release has
  // no explicit alias for, and the parent segment still names the search code.
  assert.equal(searchCodeOfAdtType("CLAS/XX"), "CLAS")
  // A parent that is no search code at all stays unknown, not an error: the caller decides.
  assert.equal(searchCodeOfAdtType("SMOD/XX"), undefined)
  assert.equal(searchCodeOfAdtType("SMOD"), undefined)
})

test("the searchable vocabulary is the search codes plus the paths, with no duplicates", () => {
  const tokens = [...SEARCHABLE_OBJECT_TYPE_TOKENS]
  assert.equal(new Set(tokens).size, tokens.length)
  for (const code of DEFAULT_OBJECT_TYPES) assert.ok(tokens.includes(code), code)
  for (const path of ["FUGR/FF", "FUNC/FM", "PROG/P", "PROG/I", "FUGR/I", "FUGR/F", "CLAS/OC"]) {
    assert.ok(tokens.includes(path), path)
  }
})

test("a type list is translated in order and de-duplicated", () => {
  assert.deepEqual(searchTypeCodes(["FUGR/FF", "FUNC", "CLAS/OC", "PROG/I"]), [
    "FUNC",
    "CLAS",
    "PROG"
  ])
  assert.deepEqual(searchTypeCodes(["FUNC"]), ["FUNC"])
})

test("function modules are recognised in every accepted vocabulary", () => {
  for (const token of FUNCTION_MODULE_TYPE_TOKENS) {
    assert.equal(isFunctionModuleType(token), true, token)
    assert.equal(isFunctionModuleType(token.toLowerCase()), true, token)
  }
  assert.equal(isFunctionModuleType("TABL"), false)
  assert.equal(isFunctionModuleType("FUGR/F"), false)
})
