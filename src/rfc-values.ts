export interface RfcValueContract {
  dataType: string
  length?: number
  decimals?: number
}

export function rfcValueContract(
  header: Record<string, string>,
  typeName: string
): RfcValueContract {
  const dataType = header.DATATYPE?.trim().toUpperCase() ?? ""
  const character = ["CHAR", "NUMC", "CLNT", "LANG", "UNIT", "CUKY", "ACCP"].includes(dataType)
  const decimal = ["DEC", "CURR", "QUAN"].includes(dataType)
  if (
    !character &&
    !decimal &&
    !["DATS", "TIMS", "INT1", "INT2", "INT4", "FLTP", "STRG", "SSTRING"].includes(dataType)
  ) {
    throw new Error(`Unverified RFC scalar type for ${typeName}`)
  }
  if (character || decimal || dataType === "SSTRING") {
    const length = Number(header.LENG)
    if (!Number.isSafeInteger(length) || length < 1) {
      throw new Error(`DDIC character length or precision is invalid for ${typeName}`)
    }
    if (decimal) {
      const decimals = Number(header.DECIMALS)
      if (
        header.DECIMALS === undefined ||
        !Number.isSafeInteger(decimals) ||
        decimals < 0 ||
        decimals > length ||
        length > 31
      ) {
        throw new Error(
          `DDIC decimal precision is invalid for ${typeName} ` +
            `(DATATYPE ${dataType}, LENG ${header.LENG ?? ""}, DECIMALS ${header.DECIMALS ?? ""})`
        )
      }
      return { dataType, length, decimals }
    }
    return { dataType, length }
  }
  return { dataType }
}

export function validateRfcValue(
  contract: RfcValueContract,
  value: string,
  field: string,
  output = false
): void {
  const { dataType, length, decimals } = contract
  if (
    length !== undefined &&
    !["DEC", "CURR", "QUAN"].includes(dataType) &&
    value.length > length
  ) {
    throw new Error(`${field} exceeds ${length} characters`)
  }
  // SAP output has its own lexical format; preserve it instead of normalizing or rounding it.
  if (output || value === "") return
  if (dataType === "NUMC" && !/^\d+$/.test(value)) {
    throw new Error(`${field} must contain only digits or be initial`)
  }
  const numeric = value.trim()
  if (["DEC", "CURR", "QUAN"].includes(dataType)) {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(numeric)) {
      throw new Error(`${field} must use decimal text without grouping or an exponent`)
    }
    const [whole = "", fraction = ""] = numeric.replace(/^[+-]/, "").split(".")
    if (
      whole.replace(/^0+/, "").length > length! - decimals! ||
      fraction.replace(/0+$/, "").length > decimals!
    ) {
      throw new Error(`${field} exceeds DDIC precision ${length}, scale ${decimals}`)
    }
  }
  const bounds: Record<string, [bigint, bigint]> = {
    INT1: [0n, 255n],
    INT2: [-32768n, 32767n],
    INT4: [-2147483648n, 2147483647n]
  }
  const range = bounds[dataType]
  if (range) {
    if (!/^[+-]?\d+$/.test(numeric)) throw new Error(`${field} must be integer text`)
    const integer = BigInt(numeric)
    if (integer < range[0] || integer > range[1])
      throw new Error(`${field} exceeds ${dataType} range`)
  }
}
