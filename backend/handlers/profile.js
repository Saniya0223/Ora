import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { db } from "../lib/clients.js";
import { studentProfileSchema } from "../lib/contracts.js";

const editableProfile = studentProfileSchema.pick({ name: true, program: true, year: true, section: true });
const send = (statusCode, body) => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) });
export async function handleProfile(request, { db, env = process.env } = {}) {
  if (!env.STUDENT_PROFILE_TABLE) return send(503, { error: { code: "NOT_CONFIGURED", message: "Profile setup is not connected yet." } });
  try {
    if (request.requestContext?.http?.method === "GET") {
      const response = await db.send(new GetCommand({ TableName: env.STUDENT_PROFILE_TABLE, Key: { userId: "demo-user" } }));
      if (!response.Item) return send(200, { profile: null });
      const { classroomTokens, ...profile } = studentProfileSchema.parse(response.Item);
      return send(200, { profile });
    }
    if (request.requestContext?.http?.method === "PUT") {
      const body = z.strictObject({ name: z.string().trim().min(1).max(100), program: z.string().trim().min(1).max(100), year: z.string().trim().min(1).max(30), section: z.string().trim().min(1).max(30) }).safeParse(JSON.parse(request.body ?? ""));
      if (!body.success) return send(400, { error: { code: "INVALID_PROFILE", message: "Provide your name, program, year, and section." } });
      const existing = await db.send(new GetCommand({ TableName: env.STUDENT_PROFILE_TABLE, Key: { userId: "demo-user" }, ConsistentRead: true }));
      const item = studentProfileSchema.parse({ ...(existing.Item ?? { connectedCourses: [], timetableSlots: [] }), ...body.data, userId: "demo-user" });
      await db.send(new PutCommand({ TableName: env.STUDENT_PROFILE_TABLE, Item: item }));
      const { classroomTokens, ...profile } = item;
      return send(200, { profile });
    }
    return send(404, { error: { code: "NOT_FOUND", message: "This endpoint does not exist." } });
  } catch {
    return send(400, { error: { code: "INVALID_PROFILE", message: "Provide your name, program, year, and section." } });
  }
}
export const handler = (request) => handleProfile(request, { db });
