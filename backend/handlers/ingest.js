import { z } from "zod";
import { db, bedrock, s3, textract } from "../lib/clients.js";
import { startDocument } from "../lib/documents.js";
import { ingestNotice, noticeTextSchema, queryEvents } from "../lib/ingestion.js";
import { IngestionError } from "../lib/errors.js";
import { isAIConfigured } from "../lib/ai-providers.js";
import { deadlineInstant } from "../lib/time.js";

const requestSchema = z.strictObject({ text: noticeTextSchema });
const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

export async function handleRequest(request, { db, bedrock, s3, textract, env = process.env, now } = {}) {
  try {
    const method = request.requestContext?.http?.method;
    const path = request.rawPath;
    if (!((method === "GET" && path === "/events") || (method === "POST" && path === "/ingest"))) {
      return json(404, { error: { code: "NOT_FOUND", message: "This endpoint does not exist." } });
    }
    let text;
    let s3Key;
    if (method === "POST") {
      const contentType = Object.entries(request.headers ?? {}).find(([name]) => name.toLowerCase() === "content-type")?.[1];
      if (contentType && contentType.split(";")[0].trim().toLowerCase() !== "application/json") {
        throw new IngestionError(415, "INVALID_CONTENT_TYPE", "Send the notice as JSON.");
      }
      const body = request.isBase64Encoded ? Buffer.from(request.body ?? "", "base64").toString("utf8") : request.body ?? "";
      if (Buffer.byteLength(body, "utf8") > 64_000) throw new IngestionError(413, "NOTICE_TOO_LARGE", "Keep the notice under 12,000 characters.");
      let parsed;
      try { parsed = JSON.parse(body); }
      catch { throw new IngestionError(400, "INVALID_JSON", "The notice request is not valid JSON."); }
      if (parsed && typeof parsed === "object" && Object.keys(parsed).length === 1 && typeof parsed.s3Key === "string" && parsed.s3Key.trim()) {
        s3Key = parsed.s3Key;
      } else {
        const validated = requestSchema.safeParse(parsed);
        if (!validated.success) throw new IngestionError(400, "INVALID_NOTICE", "Provide only a text field containing 1–12,000 characters, or an uploaded PDF key.");
        text = validated.data.text;
      }
    }
    if (!env.ACADEMIC_EVENTS_TABLE || (method === "POST" && (!env.STUDENT_PROFILE_TABLE || !isAIConfigured(env)))) {
      throw new IngestionError(503, "NOT_CONFIGURED", "The notice service is not connected yet. Please try again later.");
    }
    const dependencies = {
      db, bedrock, env, now, tableName: env.ACADEMIC_EVENTS_TABLE,
      profileTableName: env.STUDENT_PROFILE_TABLE, modelId: env.BEDROCK_MODEL_ID,
    };
    if (s3Key) {
      if (!env.UPLOAD_BUCKET) throw new IngestionError(503, "NOT_CONFIGURED", "PDF import is not connected yet.");
      return json(202, await startDocument({ s3Key, kind: "notice" }, { ...dependencies, s3, textract, bucket: env.UPLOAD_BUCKET }));
    }
    if (method === "GET") {
      const events = (await queryEvents(dependencies)).filter((event) => event.status === "ACTIVE")
        .sort((left, right) => deadlineInstant(left.currentDeadline) - deadlineInstant(right.currentDeadline));
      return json(200, { events });
    }
    const result = await ingestNotice({ text, sourceType: "manual", sourceRef: null }, dependencies);
    return json(result.action === "CREATE" ? 201 : 200, result);
  } catch (error) {
    if (error instanceof IngestionError) return json(error.statusCode, { error: { code: error.code, message: error.message } });
    if (error.name === "AbortError" || error.name === "TimeoutError" || error.code === "TIMEOUT") {
      return json(504, { error: { code: "TIMEOUT", message: "The result could not be confirmed in time. Refresh your events before retrying." } });
    }
    // Never log request bodies, model output, profile data, or SDK error messages.
    console.error(JSON.stringify({ code: "NOTICE_SERVICE_ERROR", requestId: request.requestContext?.requestId }));
    return json(503, { error: { code: "SERVICE_UNAVAILABLE", message: "The notice service is temporarily unavailable. Your text has been kept so you can retry." } });
  }
}

export const handler = (request) => handleRequest(request, { db, bedrock, s3, textract });
