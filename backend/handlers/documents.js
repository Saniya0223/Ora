import { randomUUID } from "node:crypto";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { db, bedrock, s3, textract } from "../lib/clients.js";
import { prepareUpload, startDocument, finishDocument } from "../lib/documents.js";
import { timetableSlotSchema } from "../lib/contracts.js";
import { IngestionError } from "../lib/errors.js";
import { isAIConfigured } from "../lib/ai-providers.js";

const json = (statusCode, body) => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) });
const SLOT_PATH = new RegExp("^/timetable/slots/([0-9a-f-]{36})$");
const withIds = (slots) => slots.map((slot) => (slot.id ? slot : { ...slot, id: randomUUID() }));

async function readTimetable(db, tableName) {
  const result = await db.send(new GetCommand({ TableName: tableName, Key: { userId: "demo-user" }, ProjectionExpression: "timetableSlots, timetableSource", ConsistentRead: true }));
  return { exists: Boolean(result.Item), slots: result.Item?.timetableSlots ?? [], source: result.Item?.timetableSource ?? null };
}

async function writeTimetable(db, tableName, slots, source) {
  const names = { "#t": "timetableSlots" };
  const values = { ":slots": slots };
  let update = "SET #t = :slots";
  if (source) { names["#s"] = "timetableSource"; values[":source"] = source; update += ", #s = :source"; }
  try {
    await db.send(new UpdateCommand({ TableName: tableName, Key: { userId: "demo-user" }, UpdateExpression: update, ExpressionAttributeNames: names, ExpressionAttributeValues: values, ConditionExpression: "attribute_exists(userId)" }));
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") throw new IngestionError(409, "PROFILE_REQUIRED", "Save your student profile before saving a timetable.");
    throw error;
  }
}

export async function handleDocuments(request, dependencies) {
  const env = dependencies.env ?? process.env;
  const method = request.requestContext?.http?.method;
  const path = request.rawPath;
  try {
    if (!env.UPLOAD_BUCKET || !env.STUDENT_PROFILE_TABLE) throw new IngestionError(503, "NOT_CONFIGURED", "Document import is not connected yet.");
    const deps = { ...dependencies, env, bucket: env.UPLOAD_BUCKET, tableName: env.ACADEMIC_EVENTS_TABLE, profileTableName: env.STUDENT_PROFILE_TABLE, modelId: env.BEDROCK_MODEL_ID };
    if (method === "GET" && path === "/timetable") {
      const timetable = await readTimetable(dependencies.db, env.STUDENT_PROFILE_TABLE);
      // Slots saved before slot IDs existed get stable IDs once, on first read.
      if (timetable.slots.some((slot) => !slot.id)) {
        timetable.slots = withIds(timetable.slots);
        await writeTimetable(dependencies.db, env.STUDENT_PROFILE_TABLE, timetable.slots);
      }
      return json(200, { slots: timetable.slots, source: timetable.source });
    }
    // Single-slot delete takes no body, so it is routed before body parsing.
    if (method === "DELETE" && SLOT_PATH.test(path)) {
      const slotId = SLOT_PATH.exec(path)[1];
      const timetable = await readTimetable(dependencies.db, env.STUDENT_PROFILE_TABLE);
      if (!timetable.slots.some((slot) => slot.id === slotId)) throw new IngestionError(404, "NOT_FOUND", "That timetable slot was not found.");
      const slots = timetable.slots.filter((slot) => slot.id !== slotId);
      await writeTimetable(dependencies.db, env.STUDENT_PROFILE_TABLE, slots, timetable.source ? { ...timetable.source, updatedAt: new Date().toISOString() } : undefined);
      return json(200, { slots, source: timetable.source });
    }
    if (method === "GET" && /^\/documents\/[0-9a-f-]+$/.test(path)) {
      if (!z.uuid().safeParse(path.split("/")[2]).success) throw new IngestionError(400, "INVALID_JOB", "Invalid import identifier.");
      const job = await finishDocument(path.split("/")[2], deps);
      return json(job.status === "PROCESSING" ? 202 : 200, job);
    }
    let body;
    try { if ((request.body?.length ?? 0) > 100_000) throw new Error(); body = JSON.parse(request.isBase64Encoded ? Buffer.from(request.body, "base64").toString("utf8") : request.body ?? ""); }
    catch { throw new IngestionError(400, "INVALID_JSON", "The document request is invalid."); }
    // Replace the whole timetable (a reviewed PDF import, or a manual save).
    // source is optional: pass the PDF fileName/jobId to record provenance.
    if (method === "PUT" && path === "/timetable") {
      const parsed = z.strictObject({
        slots: z.array(timetableSlotSchema).max(150),
        source: z.strictObject({ fileName: z.string().trim().min(1).max(200).nullable().optional(), jobId: z.uuid().nullable().optional() }).optional(),
      }).safeParse(body);
      if (!parsed.success) throw new IngestionError(400, "INVALID_TIMETABLE", "Check the days, subjects, and start/end times in the timetable.");
      const at = new Date().toISOString();
      const imported = Boolean(parsed.data.source?.fileName || parsed.data.source?.jobId);
      const previous = (await readTimetable(dependencies.db, env.STUDENT_PROFILE_TABLE)).source;
      const source = imported
        ? { kind: "PDF", fileName: parsed.data.source.fileName ?? null, jobId: parsed.data.source.jobId ?? null, importedAt: at, updatedAt: at }
        : { kind: previous?.kind ?? "MANUAL", fileName: previous?.fileName ?? null, jobId: previous?.jobId ?? null, importedAt: previous?.importedAt ?? at, updatedAt: at };
      const slots = withIds(parsed.data.slots);
      await writeTimetable(dependencies.db, env.STUDENT_PROFILE_TABLE, slots, source);
      return json(200, { slots, source });
    }
    // Correct one slot in place, keeping its ID.
    if (method === "PUT" && SLOT_PATH.test(path)) {
      const slotId = SLOT_PATH.exec(path)[1];
      const { id, ...fields } = body ?? {};
      const parsed = timetableSlotSchema.safeParse({ ...fields, id: slotId });
      if (!parsed.success) throw new IngestionError(400, "INVALID_TIMETABLE", "Check the day, subject, and start/end times for this slot.");
      const timetable = await readTimetable(dependencies.db, env.STUDENT_PROFILE_TABLE);
      if (!timetable.slots.some((slot) => slot.id === slotId)) throw new IngestionError(404, "NOT_FOUND", "That timetable slot was not found.");
      const slots = timetable.slots.map((slot) => (slot.id === slotId ? parsed.data : slot));
      const source = { ...(timetable.source ?? { kind: "MANUAL", fileName: null, jobId: null, importedAt: new Date().toISOString() }), updatedAt: new Date().toISOString() };
      await writeTimetable(dependencies.db, env.STUDENT_PROFILE_TABLE, slots, source);
      return json(200, { slot: parsed.data, slots, source });
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
    // The error class and HTTP status (e.g. "AccessDenied", 403) are safe to log; messages are not.
    console.error(JSON.stringify({ code: "DOCUMENT_ERROR", requestId: request.requestContext?.requestId, errorName: error?.name ?? null, httpStatus: error?.$metadata?.httpStatusCode ?? null, step: error?.step ?? null }));
    return json(503, { error: { code: "DOCUMENT_UNAVAILABLE", message: "The document service is unavailable. Please retry." } });
  }
}

export const handler = (request) => handleDocuments(request, { db, bedrock, s3, textract });
