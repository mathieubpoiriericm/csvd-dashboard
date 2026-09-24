/** Rebuild a server response with a mutable header list, preserving its body. */
export function rewriteResponseHeaders(
  response: Response,
  rewrite: (headers: Headers) => void,
): Response {
  const headers = new Headers(response.headers);
  rewrite(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
