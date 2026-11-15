// Shared HTTP helpers: JSON responses, error envelope, request body reading.
// The JSON error shape keeps the v0.2.0 "error" message contract; "code" is
// an additive machine-readable field for v0.3.0 clients.

export class ApiError extends Error {
  constructor(status, message, code = undefined, cause = undefined) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });

  res.end(JSON.stringify(value));
}

export function sendError(res, err) {
  if (!(err instanceof ApiError)) {
    console.error("API error:", err && err.message ? err.message : err);
    err = new ApiError(500, "Internal error");
  }

  if (err.cause !== undefined) {
    console.error("API error cause:", err.cause.message ?? err.cause);
  }

  const body =
    err.code === undefined
      ? { error: err.message }
      : { error: err.message, code: err.code };

  sendJson(res, err.status, body);
}

// Reads the full request body as a UTF-8 string, enforcing the size cap
// while streaming (same live enforcement as v0.2.0).
export async function readBody(req, maxBytes) {
  let size = 0;
  const chunks = [];

  for await (const chunk of req) {
    size += chunk.length;

    if (size > maxBytes) {
      throw new ApiError(413, "Request too large");
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}
