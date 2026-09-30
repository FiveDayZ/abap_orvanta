/**
 * Arithmetic over the values the reader returned, following ABAP's calculation types.
 *
 * Why this module exists: the degraded read path never lets SAP evaluate an expression. The caller's
 * statement is translated into a plain projection plus simple filters, so anything derived has to be
 * computed here. That makes this the one place in the query path where the service *invents* a value,
 * and therefore the one place where it can silently answer a question nobody asked.
 *
 * The rules are not invented. They are the rules for `arith_exp` in the ABAP keyword documentation
 * (SAP NetWeaver AS ABAP 7.51, "arith_exp - Calculation Type and Calculation Rules"), which states:
 *
 * - The calculation type is chosen from all operands, in this priority: decfloat16/34 -> decfloat34;
 *   f (or the operator `**`) -> f; p -> p; int8 -> int8; i, b, s -> i.
 * - Operands of other types count as: d and t as i, c and n and string as p, x and xstring as i.
 * - Calculation type i/int8 is integer arithmetic, and "each subtotal that is not an integer (after a
 *   division) is rounded commercially to the nearest integer". Overflow raises
 *   CX_SY_ARITHMETIC_OVERFLOW.
 * - Calculation type p is fixed-point decimal arithmetic ("the decimal point for numbers of type p is
 *   not fixed" during the calculation), internally accurate to 31 places and, after an overflow
 *   there, to 63.
 * - Calculation type f is binary floating point of the platform, whose subtotals "can produce
 *   rounding errors".
 *
 * Two consequences are decisions this module makes and documents rather than discovers:
 *
 * 1. **A statement has no target field.** ABAP converts the result of an expression to the type of
 *    the field it is assigned to, and for type p it is that field which fixes the number of decimal
 *    places. A `SELECT` list has no such field, so the scale has to come from the statement itself.
 *    It comes from the digits the caller wrote: `+`/`-` keep the widest operand scale, `*` keeps the
 *    sum of both. Every such result is exact - no decimal place is ever rounded away - which is
 *    strictly more precise than ABAP, whose own arithmetic cannot hold more than 63 places.
 * 2. **Division is refused where its scale is undetermined, and exact where the documentation fixes
 *    it.** Under calculation type i/int8 the documentation fixes it (commercial rounding to integer,
 *    which is implemented). Under calculation type p the scale would come from the missing target
 *    field, so `/` is refused by name instead of a scale being invented.
 *
 * Types f and decfloat34 are refused rather than emulated: the reader returns a floating point field
 * in scientific notation, and the documentation says of calculation type f itself that subtotals can
 * carry rounding errors. An expression layer that reproduces rounding errors is not worth having.
 */

/** The ABAP calculation types. */
export type CalculationType = "i" | "int8" | "p" | "f" | "decfloat34"

/**
 * One operand's type as SAP's own dictionary states it: the DDIC type name (`DATATYPE`, for example
 * `INT4`, `DEC`, `DATS`, `FLTP`) plus the declared decimal places.
 *
 * `DATATYPE` - not the one-character `INTTYPE` - is what this module classifies on, because the two
 * disagree in a way that matters: an `INT4` field is stored with `INTTYPE = X`, and `X` on its own
 * cannot be told apart from a byte field. The dictionary is read through the same reviewed path as
 * everything else, so this is SAP's answer rather than a table of names maintained here.
 */
export interface OperandType {
  calculationType: CalculationType
  dataType: string
  decimals: number
}

/**
 * Classify a DDIC type name. Refuses (`undefined`) a type this module cannot place, so the caller can
 * name it in a refusal instead of guessing a calculation rule for it.
 */
export function calculationTypeOf(dataType: string): CalculationType | undefined {
  const name = dataType.toUpperCase()
  // Decimal floating point outranks everything, then binary floating point, then packed.
  if (name === "DECFLOAT16" || name === "DECFLOAT34" || name === "DF16_DEC" || name === "DF34_DEC")
    return "decfloat34"
  if (name === "FLTP" || name === "FLOAT") return "f"
  if (name === "DEC" || name === "CURR" || name === "QUAN" || name === "P") return "p"
  if (name === "INT8") return "int8"
  if (name === "INT1" || name === "INT2" || name === "INT4" || name === "INT") return "i"
  // "b" and "s" are the one-character names of the small integers; x and xstring count as i.
  if (name === "B" || name === "S") return "i"
  if (name === "RAW" || name === "LRAW" || name === "RAWSTRING" || name === "XSTRING") return "i"
  // d and t count as i.
  if (name === "DATS" || name === "TIMS" || name === "D" || name === "T") return "i"
  // c, n and string count as p. STRG and SSTRING are the DDIC names of the string types, LCHR the
  // long character field (a field of that type holds text), and ACCP the posting period (six
  // characters, for example '2026009'); none of them is a numeric type, and the documentation's
  // rule is what a character-like operand counts as.
  if (
    name === "CHAR" ||
    name === "NUMC" ||
    name === "STRING" ||
    name === "STRG" ||
    name === "SSTRING" ||
    name === "LCHR" ||
    name === "ACCP" ||
    name === "CLNT" ||
    name === "LANG" ||
    name === "CUKY" ||
    name === "UNIT" ||
    name === "C" ||
    name === "N"
  )
    return "p"
  return undefined
}

/** A plain decimal exactly as the reader writes it, split so it can be computed without floats. */
export function numericParts(
  value: string
): { sign: number; integer: string; fraction: string } | undefined {
  const match = value.trim().match(/^(-)?(\d+)(?:\.(\d+))?$/)
  if (!match) return undefined
  return { sign: match[1] ? -1 : 1, integer: match[2]!, fraction: match[3] ?? "" }
}

/** Render an unscaled integer back into decimal notation at `scale` decimal places. */
export function formatUnscaled(value: bigint, scale: number): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0")
  const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
  return negative ? `-${text}` : text
}

/** Render a scaled integer back into the reader's decimal notation, keeping the widest scale seen. */
export function formatScaled(total: number, scale: number): string {
  return formatUnscaled(BigInt(total), scale)
}

/**
 * Compare two decimal texts exactly: -1, 0 or 1, or `undefined` when one of them is not a plain
 * decimal.
 *
 * A term in a `WHERE` clause compares the value this layer computed with the literal the caller
 * wrote, and both are decimal text. Comparing them as numbers would put a binary float between two
 * exactly known decimals, which is the very error the rest of this module exists to avoid.
 */
export function compareDecimals(left: string, right: string): number | undefined {
  const a = numericParts(left)
  const b = numericParts(right)
  if (!a || !b) return undefined
  const scale = Math.max(a.fraction.length, b.fraction.length)
  const scaledA = BigInt(`${a.integer}${a.fraction.padEnd(scale, "0")}`) * BigInt(a.sign)
  const scaledB = BigInt(`${b.integer}${b.fraction.padEnd(scale, "0")}`) * BigInt(b.sign)
  return scaledA < scaledB ? -1 : scaledA > scaledB ? 1 : 0
}

/** A decimal held as an exact integer plus the number of digits after the point. */
interface Exact {
  value: bigint
  scale: number
}

/** Numeric literals: an integer one is type i, one with a fraction cannot be i. */
function literalType(text: string): OperandType {
  const fraction = text.includes(".") ? text.split(".")[1]!.length : 0
  return {
    calculationType: fraction > 0 ? "p" : "i",
    dataType: fraction > 0 ? "DEC" : "INT4",
    decimals: fraction
  }
}

export type ArithmeticNode =
  | { kind: "column"; name: string }
  | { kind: "literal"; text: string }
  | { kind: "negate"; operand: ArithmeticNode }
  | {
      kind: "binary"
      operator: "+" | "-" | "*" | "/"
      left: ArithmeticNode
      right: ArithmeticNode
    }

/** The value and type of one resolved column, as the read returned it. */
export interface ResolvedOperand {
  text: string
  type: OperandType
}

/**
 * Parse the arithmetic subset: `+ - * /`, standard precedence, unary minus and parentheses around an
 * arithmetic operand. Anything else returns `undefined` so the caller keeps the platform's own error,
 * exactly as the rest of this dialect behaves.
 */
export function parseArithmetic(text: string): ArithmeticNode | undefined {
  const source = text.trim()
  let index = 0
  const skip = () => {
    while (index < source.length && source[index] === " ") index++
  }
  const fail = (): undefined => undefined

  const parseExpression = (): ArithmeticNode | undefined => {
    let left = parseTerm()
    if (!left) return fail()
    for (;;) {
      skip()
      const operator = source[index]
      if (operator !== "+" && operator !== "-") return left
      index++
      const right = parseTerm()
      if (!right) return fail()
      left = { kind: "binary", operator, left, right }
    }
  }

  const parseTerm = (): ArithmeticNode | undefined => {
    let left = parseUnary()
    if (!left) return fail()
    for (;;) {
      skip()
      const operator = source[index]
      if (operator !== "*" && operator !== "/") return left
      index++
      const right = parseUnary()
      if (!right) return fail()
      left = { kind: "binary", operator, left, right }
    }
  }

  const parseUnary = (): ArithmeticNode | undefined => {
    skip()
    if (source[index] === "-") {
      index++
      const operand = parseUnary()
      return operand ? { kind: "negate", operand } : fail()
    }
    return parsePrimary()
  }

  const parsePrimary = (): ArithmeticNode | undefined => {
    skip()
    if (source[index] === "(") {
      index++
      const inner = parseExpression()
      if (!inner) return fail()
      skip()
      if (source[index] !== ")") return fail()
      index++
      return inner
    }
    const numeric = /^\d+(?:\.\d+)?/.exec(source.slice(index))
    if (numeric) {
      index += numeric[0].length
      return { kind: "literal", text: numeric[0] }
    }
    const name = /^(?:[A-Za-z][A-Za-z0-9_]*\.)?[A-Za-z][A-Za-z0-9_]*/.exec(source.slice(index))
    if (name) {
      index += name[0].length
      return { kind: "column", name: name[0].toUpperCase() }
    }
    return fail()
  }

  const tree = parseExpression()
  skip()
  if (!tree || index !== source.length) return undefined
  return tree
}

/** Every column an expression reads, so the caller knows what has to be projected. */
export function arithmeticColumns(node: ArithmeticNode): string[] {
  const names = new Set<string>()
  const walk = (current: ArithmeticNode): void => {
    if (current.kind === "column") names.add(current.name)
    else if (current.kind === "negate") walk(current.operand)
    else if (current.kind === "binary") {
      walk(current.left)
      walk(current.right)
    }
  }
  walk(node)
  return [...names]
}

/** The value range of a calculation type, as the documentation and the DDIC types define it. */
const integerRange: Record<"i" | "int8", { min: bigint; max: bigint }> = {
  i: { min: -2147483648n, max: 2147483647n },
  int8: { min: -9223372036854775808n, max: 9223372036854775807n }
}

/**
 * The internal accuracy of calculation type p is 31 places. Beyond it the documentation says
 * "surplus decimal places ... are rounded commercially to the nearest whole number for each
 * subtotal", and only an overflow of the integral part triggers the retry at 63. So a subtotal wider
 * than 31 places is one ABAP would have rounded, and publishing the unrounded digits would be
 * publishing a number SAP would never have produced. The layer refuses instead.
 *
 * (A SQL dialect would answer this differently: `DECIMAL(13,2) * DECIMAL(13,2)` is an exact
 * `DECIMAL(26,4)`. This layer follows ABAP, because matching SAP is what it is for.)
 */
const packedPlaceLimit = 31

function refusal(code: string, message: string): Error {
  return new Error(`TABLE_QUERY_EXPRESSION_${code}: ${message}`)
}

function parseExact(text: string, column: string | null): Exact {
  const parts = numericParts(text)
  if (!parts)
    throw refusal(
      "NOT_NUMERIC",
      `${column ? `column ${column} holds` : "the value"} "${text.slice(0, 40)}", which is not a ` +
        "plain decimal number. Only a value that is exactly what it says can take part in " +
        "arithmetic; ask SAP for the calculation instead."
    )
  const digits = BigInt(`${parts.integer}${parts.fraction}` || "0")
  return { value: parts.sign < 0 ? -digits : digits, scale: parts.fraction.length }
}

/** Commercial rounding: to the nearest integer, a half away from zero. */
function roundHalfAwayFromZero(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor
  const remainder = value % divisor
  if (remainder === 0n) return quotient
  const negative = value < 0n !== divisor < 0n
  return 2n * (remainder < 0n ? -remainder : remainder) >= (divisor < 0n ? -divisor : divisor)
    ? quotient + (negative ? -1n : 1n)
    : quotient
}

/**
 * Evaluate an arithmetic expression exactly, or refuse.
 *
 * The calculation type is fixed by every operand in the expression, and the value of each operand is
 * the text the reader returned - the same text the caller sees - so a result can be reproduced by
 * hand from the answer.
 */
export function evaluateArithmetic(
  node: ArithmeticNode,
  resolve: (column: string) => ResolvedOperand | undefined
): string {
  const types: OperandType[] = []
  const resolved = new Map<string, ResolvedOperand>()
  const values = new Map<string, Exact>()
  const texts = new Map<string, string>()

  // Types are resolved before any value is read, so a refusal caused by the *type* of an operand is
  // the one the caller sees. A floating point field is a case in point: the reader renders it in
  // scientific notation, and reporting that as "not a plain decimal" would blame the value for what
  // the calculation type makes impossible.
  const operand = (column: string): ResolvedOperand => {
    const cached = resolved.get(column)
    if (cached) return cached
    const found = resolve(column)
    if (!found)
      throw refusal(
        "COLUMN_UNKNOWN",
        `${column} is not a column this read returned, so its type is unknown. Name a column of the ` +
          "table being read."
      )
    types.push(found.type)
    resolved.set(column, found)
    return found
  }

  const exact = (column: string): Exact => {
    const cached = values.get(column)
    if (cached) return cached
    const found = operand(column)
    const parsed = parseExact(found.text, column)
    values.set(column, parsed)
    texts.set(column, found.text)
    return parsed
  }

  // The calculation type is determined from all operands before any of them is used, so the operand
  // types are collected in a first pass that ignores the operators.
  const collect = (current: ArithmeticNode): void => {
    if (current.kind === "literal") types.push(literalType(current.text))
    else if (current.kind === "column") operand(current.name)
    else if (current.kind === "negate") collect(current.operand)
    else if (current.kind === "binary") {
      collect(current.left)
      collect(current.right)
    }
  }
  collect(node)

  const rank: Record<CalculationType, number> = { i: 0, int8: 1, p: 2, f: 3, decfloat34: 4 }
  const calculationType = types.reduce<CalculationType>(
    (widest, type) => (rank[type.calculationType] > rank[widest] ? type.calculationType : widest),
    "i"
  )
  const float = types.find((type) => type.calculationType === "f")
  if (float)
    throw refusal(
      "FLOAT",
      `${float.dataType} takes part in a binary floating point calculation, whose subtotals the ` +
        "documentation itself says can carry rounding errors, and the reader returns such a field in " +
        "scientific notation. Ask SAP for the calculation instead of reading an approximation here."
    )
  const decimalFloat = types.find((type) => type.calculationType === "decfloat34")
  if (decimalFloat)
    throw refusal(
      "DECFLOAT",
      `${decimalFloat.dataType} takes part in a decimal floating point calculation. This dialect ` +
        "computes exactly or refuses; ask SAP for the calculation instead."
    )

  if (calculationType === "p") {
    const evaluate = (current: ArithmeticNode): Exact => {
      if (current.kind === "literal") return parseExact(current.text, null)
      if (current.kind === "column") return exact(current.name)
      if (current.kind === "negate") {
        const inner = evaluate(current.operand)
        return { value: -inner.value, scale: inner.scale }
      }
      const left = evaluate(current.left)
      const right = evaluate(current.right)
      if (current.operator === "/")
        throw refusal(
          "DIVISION_SCALE",
          "the number of decimal places of a packed division is fixed by the field the result is " +
            "assigned to in ABAP. A SELECT list has no such field, so this dialect refuses rather " +
            "than invent a scale. Divide in SAP, or use SUM and COUNT here."
        )
      if (current.operator === "*") {
        const exact = { value: left.value * right.value, scale: left.scale + right.scale }
        return withinPlaces(exact)
      }
      const scale = Math.max(left.scale, right.scale)
      const scaledLeft = left.value * 10n ** BigInt(scale - left.scale)
      const scaledRight = right.value * 10n ** BigInt(scale - right.scale)
      return withinPlaces({
        value: current.operator === "+" ? scaledLeft + scaledRight : scaledLeft - scaledRight,
        scale
      })
    }
    const result = evaluate(node)
    return formatUnscaled(result.value, result.scale)
  }

  const range = integerRange[calculationType === "int8" ? "int8" : "i"]
  const withinRange = (value: bigint): bigint => {
    if (value < range.min || value > range.max)
      throw refusal(
        "OVERFLOW",
        `a subtotal left the value range of type ${calculationType} (${range.min} to ${range.max}), ` +
          "which raises CX_SY_ARITHMETIC_OVERFLOW in ABAP. Narrow the calculation."
      )
    return value
  }
  const evaluate = (current: ArithmeticNode): bigint => {
    // A literal with a fraction is typed p by `literalType`, which would have made this expression's
    // calculation type p, so every literal reaching this point is an integer.
    if (current.kind === "literal") return parseExact(current.text, null).value
    if (current.kind === "column") {
      const value = exact(current.name)
      if (value.scale !== 0)
        throw refusal(
          "NOT_INTEGER",
          `${current.name} holds "${texts.get(current.name)}", which has decimal places, in a ` +
            "calculation whose type is integer. That cannot happen for a column the dictionary " +
            "declares as an integer type, so the value and the type disagree."
        )
      return value.value
    }
    if (current.kind === "negate") return withinRange(-evaluate(current.operand))
    const left = evaluate(current.left)
    const right = evaluate(current.right)
    if (current.operator === "+") return withinRange(left + right)
    if (current.operator === "-") return withinRange(left - right)
    if (current.operator === "*") return withinRange(left * right)
    if (right === 0n)
      throw refusal(
        "DIVISION_BY_ZERO",
        "a division by zero raises CX_SY_ZERODIVIDE in ABAP; no value is published for it."
      )
    return withinRange(roundHalfAwayFromZero(left, right))
  }
  return evaluate(node).toString()
}

/** Refuse a packed subtotal wider than the accuracy the documentation computes it to. */
function withinPlaces(exact: Exact): Exact {
  const digits = (exact.value < 0n ? -exact.value : exact.value).toString().length
  if (digits > packedPlaceLimit)
    throw refusal(
      "OVERFLOW",
      `a subtotal needs ${digits} places, beyond the ${packedPlaceLimit} that ABAP's fixed point ` +
        "arithmetic computes to. ABAP rounds the surplus decimal places commercially and raises " +
        "CX_SY_ARITHMETIC_OVERFLOW when even 63 places cannot hold the integral part, so this layer " +
        "refuses rather than publish digits ABAP would not have produced. Narrow the calculation, or " +
        "ask SAP."
    )
  return exact
}
