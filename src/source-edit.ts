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
  if (count === 1) return content.replace(oldString, () => newString)
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
