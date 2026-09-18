import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { db, bedrock, s3, textract } from "../lib/clients.js";
import { prepareUpload, startDocument, finishDocument } from "../lib/documents.js";
import { timetableSlotSchema } from "../lib/contracts.js";
import { IngestionError } from "../lib/errors.js";
import { isAIConfigured } from "../lib/ai-providers.js";

const json = (statusCode, body) => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) });

export async function handleDocuments(request, dependencies) {
  const env = dependencies.env ?? process.env;
  const method = request.requestContext?.http?.method;
  const path = request.rawPath;
  try {
    if (!env.UPLOAD_BUCKET || !env.STUDENT_PROFILE_TABLE) throw new IngestionError(503, "NOT_CONFIGURED", "Document import is not connected yet.");
    const deps = { ...dependencies, env, bucket: env.UPLOAD_BUCKET, tableName: env.ACADEMIC_EVENTS_TABLE, profileTableName: env.STUDENT_PROFILE_TABLE, modelId: env.BEDROCK_MODEL_ID };
    if (method === "GET" && path === "/timetable") {
      const result = await dependencies.db.send(new GetCommand({ TableName: env.STUDENT_PROFILE_TABLE, Key: { userId: "demo-user" }, ProjectionExpression: "timetableSlots" }));
      return json(200, { slots: result.Item?.timetableSlots ?? [] });
    }
    if (method === "GET" && /^\/documents\/[0-9a-f-]+$/.test(path)) {
      if (!z.uuid().safeParse(path.split("/")[2]).success) throw new IngestionError(400, "INVALID_JOB", "Invalid import identifier.");
      const job = await finishDocument(path.split("/")[2], deps);
      return json(job.status === "PROCESSING" ? 202 : 200, job);
    }
    let body;
    try { if ((request.body?.length ?? 0) > 100_000) throw new Error(); body = JSON.parse(request.isBase64Encoded ? Buffer.from(request.body, "base64").toString("utf8") : request.body ?? ""); }
    catch { throw new IngestionError(400, "INVALID_JSON", "The document request is invalid."); }
    if (method === "PUT" && path === "/timetable") {
      const parsed = z.strictObject({ slots: z.array(timetableSlotSchema).max(150) }).safeParse(body);
      if (!parsed.success) throw new IngestionError(400, "INVALID_TIMETABLE", "Check the days, subjects, and start/end times in the timetable.");
      try {
        await dependencies.db.send(new UpdateCommand({ TableName: env.STUDENT_PROFILE_TABLE, Key: { userId: "demo-user" }, UpdateExpression: "SET timetableSlots = :slots", ExpressionAttributeValues: { ":slots": parsed.data.slots }, ConditionExpression: "attribute_exists(userId)" }));
      } catch (error) {
        if (error.name === "ConditionalCheckFailedException") throw new IngestionError(409, "PROFILE_REQUIRED", "Save your student profile before saving a timetable.");
        throw error;
      }
      return json(200, parsed.data);
    }
    if (method === "POST" && path === "/uploads") return json(200, await prepareUpload(body, deps));
    if (method === "POST" && path === "/timetable") {
      if (!isAIConfigured(env)) throw new IngestionError(503, "NOT_CONFIGURED", "Timetable interpretation is not connected yet.");
      const parsed = z.strictObject({ s3Key: z.string().min(1) }).safeParse(body);
      if (!parsed.success) throw new IngestionError(400, "INVALID_UPLOAD", "Choose an uploaded timetable PDF.");
      return json(202, await startDocument({ s3Key: parsed.data.s3Key, kind: "timetable" }, deps));
    }
    return json(404, { error: { code: "NOT_FOUND", message: "This endpoint does not exist." } });
  } catch (error) {
    if (error instanceof IngestionError) return json(error.statusCode, { error: { code: error.code, message: error.message } });
    console.error(JSON.stringify({ code: "DOCUMENT_ERROR", requestId: request.requestContext?.requestId }));
    return json(503, { error: { code: "DOCUMENT_UNAVAILABLE", message: "The document service is unavailable. Please retry." } });
  }
}

export const handler = (request) => handleDocuments(request, { db, bedrock, s3, textract });
