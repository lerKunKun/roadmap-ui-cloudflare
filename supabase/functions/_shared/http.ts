export function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers,
  })
}

export function withResponseHeaders(
  response: Response,
  headers: Record<string, string>,
): Response {
  const mergedHeaders = new Headers(response.headers)

  for (const [name, value] of Object.entries(headers)) {
    mergedHeaders.set(name, value)
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: mergedHeaders,
  })
}
