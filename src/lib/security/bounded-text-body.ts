export type BoundedTextResult =
  | { ok: true; value: string }
  | { ok: false; reason: "too_large" };

/**
 * Read a request body as raw text with a hard byte cap, WITHOUT parsing it.
 *
 * Unlike {@link readBoundedJsonBody}, this returns the exact decoded body string
 * so a caller can verify a signature over the raw bytes before deciding whether
 * the payload is trustworthy enough to parse. An oversized body is rejected
 * (`too_large`) before the full body is buffered — via the declared
 * `content-length` when present, otherwise once the streamed bytes exceed the
 * cap — so the caller never does signature/HMAC work on an unbounded body.
 *
 * The decode mirrors `Request.text()` (lossy UTF-8), so the returned string is
 * byte-identical to what an unbounded `await request.text()` would have
 * produced for any body within the cap.
 */
export async function readBoundedTextBody(
  request: Request,
  maxBytes: number,
): Promise<BoundedTextResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Invalid raw body limit");
  }

  const declaredLength = parseContentLength(
    request.headers.get("content-length"),
  );
  if (declaredLength !== null && declaredLength > maxBytes) {
    return { ok: false, reason: "too_large" };
  }
  // Mirror `Request.text()` on an empty/absent body, which resolves to "".
  if (request.body === null) return { ok: true, value: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    totalBytes += result.value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: "too_large" };
    }
    chunks.push(result.value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { ok: true, value: new TextDecoder("utf-8").decode(body) };
}

function parseContentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
