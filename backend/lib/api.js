import { IngestionError } from "./errors.js";

// Frontend-safe error. Subclasses IngestionError so every existing handler's
// `instanceof IngestionError` branch renders it without change.
export class ApiError extends IngestionError {
  constructor(statusCode, code, message, details) {
    super(statusCode, code, message);
    this.name = "ApiError";
    if (details) this.details = details;
  }
}

export const notFound = (what = "item") => new ApiError(404, "NOT_FOUND", `That ${what} was not found.`);

export function json(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
    body: JSON.stringify(body),
  };
}

export function errorResponse(error) {
  return json(error.statusCode, { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
}

export function readBody(request, maxBytes = 100_000) {
  const raw = request.isBase64Encoded ? Buffer.from(request.body ?? "", "base64").toString("utf8") : request.body ?? "";
  if (!raw) return {};
  if (Buffer.byteLength(raw, "utf8") > maxBytes) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "The request is too large.");
  try { return JSON.parse(raw); } catch { throw new ApiError(400, "VALIDATION_ERROR", "The request body is not valid JSON."); }
}

// Validate with zod and surface field paths, never the rejected values, which
// may be private notes or pasted notices.
export function validate(schema, value, message = "Some fields are invalid.") {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiError(400, "VALIDATION_ERROR", message, result.error.issues.slice(0, 20).map((issue) => ({
    field: issue.path.join(".") || "(body)",
    issue: issue.message,
  })));
}

export const query = (request) => request.queryStringParameters ?? {};
