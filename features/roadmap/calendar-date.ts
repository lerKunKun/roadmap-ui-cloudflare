const DATE_INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

export function localDateInputValue(date = new Date()): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-")
}

export function isValidDateInput(value: string): boolean {
  const match = DATE_INPUT_PATTERN.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

export function createdDateTimestamp(value: string): string {
  return `${value}T00:00:00.000Z`
}
