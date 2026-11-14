/**
 * The one way a write route reads its request body: counted as it arrives
 * and abandoned past a limit, so neither a false Content-Length nor a body
 * without one makes the server hold more than that limit. The dashboard runs
 * on one machine with little memory, and `Request.formData()`, `.json()` or
 * `.text()` would buffer a body of any size before the route could look at
 * it.
 */

/**
 * The body's bytes, or null once it is past `limit` (declared or streamed).
 * A refused body is cancelled rather than drained.
 */
export async function readCappedBytes(
  req: Request,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(req.headers.get("content-length"));
  if (declared > limit) {
    await req.body?.cancel();
    return null;
  }
  if (req.body === null) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The body as UTF-8 text, or null once it is past `limit`. */
export async function readCappedText(
  req: Request,
  limit: number,
): Promise<string | null> {
  const bytes = await readCappedBytes(req, limit);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}
