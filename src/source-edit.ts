/**
 * `content` with `insertion` applied, using the same line-ending convention as the surrounding
 * source.
 *
 * SAP stores ABAP source with CRLF line endings and normalizes on save, so a candidate built with an
 * LF from the caller's `newString` is not what SAP will hold afterwards. Fingerprinting the
 * un-normalized candidate therefore reports a mismatch for every multi-line replacement even though
 * the write and the activation both succeeded (w200, 2026-09-26 09:55): the caller gets a failure
 * receipt, `outcomeMayBeUnknown: true` and "Do not repeat the same replacement" for an operation
 * that actually landed.
 *
 * The slow path below already normalized this way; the exact-match fast path did not, which is why
 * single-line replacements were unaffected and multi-line ones always failed.
 */
function withSourceLineEndings(content: string, insertion: string): string {
  if (!content.includes("\r\n")) return insertion
  return insertion.replace(/\r\n/g, "\n").replace(/(?<!\r)\n/g, "\r\n")
}

export function findAndReplaceSource(
  content: string,
  oldString: string,
  newString: string
): string {
  if (!oldString) {
    if (!content.length) return newString
    throw new Error(
      "oldString can only be empty when the SAP source is completely blank. Read the current source and provide an exact unique match."
    )
  }
  if (oldString === newString) {
    throw new Error("oldString and newString are identical. No change would be made.")
  }

  const count = countOccurrences(content, oldString)
  if (count === 1)
    return content.replace(oldString, () => withSourceLineEndings(content, newString))
  if (count > 1) {
    throw new Error(
      `Found ${count} occurrences of oldString. Include 3-5 stable surrounding lines so it matches exactly once.`
    )
  }

  const normalizedContent = content.replaceAll("\r\n", "\n")
  const normalizedOld = oldString.replaceAll("\r\n", "\n")
  const normalizedCount = countOccurrences(normalizedContent, normalizedOld)
  if (normalizedCount > 1) {
    throw new Error(
      `Found ${normalizedCount} occurrences of oldString after line-ending normalization. Include more surrounding context.`
    )
  }
  if (normalizedCount === 1) {
    const updated = normalizedContent.replace(normalizedOld, () =>
      newString.replaceAll("\r\n", "\n")
    )
    return content.includes("\r\n") ? updated.replace(/(?<!\r)\n/g, "\r\n") : updated
  }

  throw new Error(
    "Could not find oldString in the current SAP source. Re-read the object and match whitespace and indentation exactly."
  )
}

/**
 * Whether two source texts are the same object text, treating line endings as equivalent.
 *
 * Used to judge an active-source read-back: SAP stores CRLF and normalizes on save, so a difference
 * in line endings alone is a storage convention, not a different object. Everything else - including
 * trailing whitespace, ordering and content - still has to match.
 */
export function sameSourceText(left: string, right: string): boolean {
  return left.replace(/\r\n/g, "\n") === right.replace(/\r\n/g, "\n")
}

function countOccurrences(content: string, search: string): number {
  let count = 0
  let start = 0
  while (true) {
    const index = content.indexOf(search, start)
    if (index < 0) return count
    count++
    start = index + search.length
  }
}
