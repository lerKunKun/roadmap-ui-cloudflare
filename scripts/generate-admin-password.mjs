import { randomInt } from "node:crypto"
import { pathToFileURL } from "node:url"

const CHARACTER_GROUPS = [
  "ABCDEFGHJKLMNPQRSTUVWXYZ",
  "abcdefghijkmnopqrstuvwxyz",
  "23456789",
  "!@#$%^&*",
]
const ALPHABET = CHARACTER_GROUPS.join("")

function randomCharacter(alphabet) {
  return alphabet[randomInt(0, alphabet.length)]
}

export function generatePassword(length = 36) {
  if (!Number.isSafeInteger(length) || length < 32) {
    throw new Error("密码长度至少为 32 位")
  }

  const characters = CHARACTER_GROUPS.map(randomCharacter)
  while (characters.length < length) {
    characters.push(randomCharacter(ALPHABET))
  }

  for (let index = characters.length - 1; index > 0; index -= 1) {
    const target = randomInt(0, index + 1)
    ;[characters[index], characters[target]] = [characters[target], characters[index]]
  }

  return characters.join("")
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : ""
if (entryPoint === import.meta.url) {
  process.stdout.write(`${generatePassword()}\n`)
}
