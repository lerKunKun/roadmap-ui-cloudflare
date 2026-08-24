const LOCAL_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"]

export function parseAllowedOrigins(value: string | undefined): Set<string> {
  const configured = (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)

  return new Set([...LOCAL_ORIGINS, ...configured])
}

export function getCorsHeaders(
  origin: string | null,
  allowedOrigins: ReadonlySet<string>,
): Record<string, string> | null {
  if (!origin || !allowedOrigins.has(origin)) {
    return null
  }

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  }
}
