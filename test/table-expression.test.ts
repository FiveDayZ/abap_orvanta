import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import {
  arithmeticColumns,
  calculationTypeOf,
  evaluateArithmetic,
  parseArithmetic,
  type OperandType,
  type ResolvedOperand
} from "../src/table-expression.js"

/** A column whose dictionary type and reader text are given by the test. */
function operand(text: string, dataType: string, decimals = 0): ResolvedOperand {
  const calculationType = calculationTypeOf(dataType)
  assert.ok(calculationType, `${dataType} should classify`)
  return { text, type: { calculationType, dataType, decimals } as OperandType }
}

function evaluate(expression: string, columns: Record<string, ResolvedOperand>): string {
  const tree = parseArithmetic(expression)
  assert.ok(tree, `${expression} should parse`)
  return evaluateArithmetic(tree, (name) => columns[name])
}

function refusal(expression: string, columns: Record<string, ResolvedOperand>): string {
  const tree = parseArithmetic(expression)
  assert.ok(tree, `${expression} should parse`)
  try {
    evaluateArithmetic(tree, (name) => columns[name])
  } catch (error) {
    return (error as Error).message
  }
  throw new Error(`${expression} should have been refused`)
}

describe("calculation type", () => {
  // The mapping the ABAP keyword documentation gives for operands that are not numeric types:
  // "d and t as i", "c, n, and string as p", "x and xstring as i".
  it("classifies a DDIC type the way the documentation does", () => {
    assert.equal(calculationTypeOf("INT4"), "i")
    assert.equal(calculationTypeOf("INT1"), "i")
    assert.equal(calculationTypeOf("INT2"), "i")
    assert.equal(calculationTypeOf("INT8"), "int8")
    assert.equal(calculationTypeOf("DATS"), "i")
    assert.equal(calculationTypeOf("TIMS"), "i")
    assert.equal(calculationTypeOf("CHAR"), "p")
    assert.equal(calculationTypeOf("NUMC"), "p")
    assert.equal(calculationTypeOf("CLNT"), "p")
    assert.equal(calculationTypeOf("DEC"), "p")
    assert.equal(calculationTypeOf("CURR"), "p")
    assert.equal(calculationTypeOf("QUAN"), "p")
    assert.equal(calculationTypeOf("FLTP"), "f")
    assert.equal(calculationTypeOf("DECFLOAT34"), "decfloat34")
    assert.equal(calculationTypeOf("XSTRING"), "i")
  })

  // INT4 is stored with INTTYPE = X in DD03L, so a classifier reading the one-character type alone
  // cannot tell an integer from a byte field. This module classifies on DATATYPE for that reason.
  it("classifies INT4 as an integer even though its INTTYPE is X", () => {
    assert.equal(calculationTypeOf("INT4"), "i")
    assert.equal(calculationTypeOf("RAW"), "i")
  })

  it("refuses a type it cannot place instead of choosing a calculation rule", () => {
    assert.equal(calculationTypeOf("DF16_RAW"), undefined)
    assert.equal(calculationTypeOf("RSTR"), undefined)
  })

  // A posting period and a long character field are text, so the documentation's rule for a
  // character-like operand applies to them exactly as it does to CHAR.
  it("places the remaining character-like DDIC types as p", () => {
    assert.equal(calculationTypeOf("ACCP"), "p")
    assert.equal(calculationTypeOf("LCHR"), "p")
    assert.equal(calculationTypeOf("STRG"), "p")
  })
})

describe("packed arithmetic", () => {
  it("adds to the wider of the two scales without losing a digit", () => {
    assert.equal(
      evaluate("A.AMOUNT + B.AMOUNT", {
        "A.AMOUNT": operand("1.10", "DEC", 2),
        "B.AMOUNT": operand("2.2", "DEC", 1)
      }),
      "3.30"
    )
  })

  it("adds decimals exactly where a double would not", () => {
    assert.equal(
      evaluate("A.X + B.Y", {
        "A.X": operand("0.1", "DEC", 1),
        "B.Y": operand("0.2", "DEC", 1)
      }),
      "0.3"
    )
  })

  it("multiplies to the sum of both scales", () => {
    assert.equal(
      evaluate("A.X * B.Y", {
        "A.X": operand("1.5", "DEC", 1),
        "B.Y": operand("1.50", "DEC", 2)
      }),
      "2.250"
    )
  })

  it("subtracts into a negative result and keeps the width", () => {
    assert.equal(
      evaluate("A.X - B.Y", {
        "A.X": operand("1.00", "DEC", 2),
        "B.Y": operand("3.5", "DEC", 1)
      }),
      "-2.50"
    )
  })

  // "c, n, and string as p": a character field takes part as a packed number, so a numeric text with
  // leading zeros is a number and nothing about the field's width survives into the value.
  it("treats a numeric text and a character field as packed numbers", () => {
    assert.equal(evaluate("A.ZAEHL * 2", { "A.ZAEHL": operand("000012", "NUMC", 0) }), "24")
    assert.equal(evaluate("A.TEXT + 1", { "A.TEXT": operand("41", "CHAR") }), "42")
  })

  it("refuses a packed division because a SELECT list has no target field to fix its scale", () => {
    const message = refusal("A.X / B.Y", {
      "A.X": operand("1.00", "DEC", 2),
      "B.Y": operand("4", "DEC", 0)
    })
    assert.match(message, /^TABLE_QUERY_EXPRESSION_DIVISION_SCALE:/)
    assert.match(message, /no such field/)
  })

  it("refuses a value that is not a plain decimal and names it", () => {
    const message = refusal("A.X + 1", { "A.X": operand("12,5", "CHAR") })
    assert.match(message, /^TABLE_QUERY_EXPRESSION_NOT_NUMERIC:/)
    assert.match(message, /"12,5"/)
  })

  it("refuses a subtotal beyond the internal accuracy instead of rounding it", () => {
    const wide = "123456789012345678901234567890123"
    const message = refusal("A.X * B.Y", {
      "A.X": operand(wide, "DEC", 0),
      "B.Y": operand(wide, "DEC", 0)
    })
    assert.match(message, /^TABLE_QUERY_EXPRESSION_OVERFLOW:/)
    assert.match(message, /31 that ABAP's fixed point arithmetic computes to/)
    assert.match(message, /CX_SY_ARITHMETIC_OVERFLOW/)
  })

  it("keeps a product that stays inside the accuracy", () => {
    assert.equal(
      evaluate("A.X * B.Y", {
        "A.X": operand("12345678901234.56", "DEC", 2),
        "B.Y": operand("100", "DEC", 0)
      }),
      "1234567890123456.00"
    )
  })
})

describe("integer arithmetic", () => {
  // "each subtotal that is not an integer (after a division) is rounded commercially to the nearest
  // integer" - commercial rounding is a half away from zero.
  it("rounds a division commercially to the nearest integer", () => {
    assert.equal(evaluate("7 / 2", {}), "4")
    assert.equal(evaluate("5 / 2", {}), "3")
    assert.equal(evaluate("1 / 3 + 1 / 3 + 1 / 3", {}), "0")
    assert.equal(
      evaluate("A.X / B.Y", { "A.X": operand("7", "INT4"), "B.Y": operand("-2", "INT4") }),
      "-4"
    )
  })

  it("refuses a division by zero the way ABAP raises CX_SY_ZERODIVIDE", () => {
    const message = refusal("A.X / B.Y", {
      "A.X": operand("7", "INT4"),
      "B.Y": operand("0", "INT4")
    })
    assert.match(message, /^TABLE_QUERY_EXPRESSION_DIVISION_BY_ZERO:/)
    assert.match(message, /CX_SY_ZERODIVIDE/)
  })

  // "d and t as i": a date in an arithmetic expression is the integer its digits spell.
  it("computes a date as the integer its digits spell", () => {
    assert.equal(evaluate("A.DATUM + 1", { "A.DATUM": operand("20260930", "DATS") }), "20260931")
  })

  it("refuses a subtotal outside the value range of the calculation type", () => {
    const message = refusal("A.X + 1", { "A.X": operand("2147483647", "INT4") })
    assert.match(message, /^TABLE_QUERY_EXPRESSION_OVERFLOW:/)
    assert.match(message, /type i/)
  })

  it("uses the wider range of int8 for an int8 operand", () => {
    assert.equal(evaluate("A.X + 1", { "A.X": operand("2147483648", "INT8") }), "2147483649")
    const message = refusal("A.X + 1", { "A.X": operand("9223372036854775807", "INT8") })
    assert.match(message, /type int8/)
  })
})

describe("floating point", () => {
  // The documentation says of calculation type f itself that subtotals "can produce rounding errors",
  // and the reader returns such a field in scientific notation. Neither is something to reproduce.
  it("refuses a binary floating point operand by name", () => {
    const message = refusal("A.X + 1", { "A.X": operand("0.000000000E+00", "FLTP", 16) })
    assert.match(message, /^TABLE_QUERY_EXPRESSION_FLOAT:/)
    assert.match(message, /FLTP/)
  })

  it("refuses a decimal floating point operand by name", () => {
    const message = refusal("A.X + 1", { "A.X": operand("1.5", "DECFLOAT34") })
    assert.match(message, /^TABLE_QUERY_EXPRESSION_DECFLOAT:/)
  })
})

describe("parsing", () => {
  it("gives multiplication a higher precedence than addition", () => {
    assert.equal(evaluate("1 + 2 * 3", {}), "7")
    assert.equal(evaluate("2 * 3 + 1", {}), "7")
  })

  it("evaluates left to right within one precedence level", () => {
    assert.equal(evaluate("10 - 3 - 2", {}), "5")
  })

  it("honours parentheses around an arithmetic operand", () => {
    assert.equal(evaluate("(1 + 2) * 3", {}), "9")
    assert.equal(evaluate("2 * (A.X + 1)", { "A.X": operand("2", "INT4") }), "6")
  })

  it("accepts a unary minus", () => {
    assert.equal(evaluate("-3 + 5", {}), "2")
    assert.equal(evaluate("2 * -3", {}), "-6")
  })

  // An integer literal is type i and a literal with a fraction cannot be, which is why `1 / 3` is
  // integer arithmetic (0) while `1.0 / 3` is a packed division and therefore refused.
  it("types an integer literal as i and a fractional literal as p", () => {
    assert.equal(evaluate("1 / 3", {}), "0")
    assert.match(refusal("1.0 / 3", {}), /^TABLE_QUERY_EXPRESSION_DIVISION_SCALE:/)
  })

  it("normalizes a column name and reports which columns an expression reads", () => {
    const tree = parseArithmetic("a.x + b.y * 2")
    assert.ok(tree)
    assert.deepEqual(arithmeticColumns(tree).sort(), ["A.X", "B.Y"])
  })

  it("refuses a statement it cannot describe exactly", () => {
    for (const text of ["A.X % 2", "SUM(A.X)", "A.X AS Y", "A.X +", "(A.X", "A.X, B.Y", ""])
      assert.equal(parseArithmetic(text), undefined, `${text} should not parse`)
  })

  it("refuses a column the read did not return", () => {
    const message = refusal("A.X + B.MISSING", { "A.X": operand("1", "INT4") })
    assert.match(message, /^TABLE_QUERY_EXPRESSION_COLUMN_UNKNOWN:/)
    assert.match(message, /B\.MISSING/)
  })
})
