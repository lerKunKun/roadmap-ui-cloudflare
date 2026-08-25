import ipaddr from "ipaddr.js"

export function normalizeIp(value: string): string {
  try {
    const address = ipaddr.parse(value.trim())

    if (address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress()) {
      return address.toIPv4Address().toString()
    }

    return address.toString()
  } catch {
    throw new Error("无效的来源 IP")
  }
}

export async function hashIp(ip: string, salt: string): Promise<string> {
  if (!salt) {
    throw new Error("投票哈希盐未配置")
  }

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(ip),
  )

  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}
