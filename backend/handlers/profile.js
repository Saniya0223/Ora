import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { db } from "../lib/clients.js";
import { academicWeek, loadProfile, publicProfile } from "../lib/student-profile.js";
import { isValidTimeZone } from "../lib/zone.js";

const send = (statusCode, body) => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) });

// name/program/year/section are required as before. semester, semesterStartDate
// (which drives the academic week), and timezone are optional; sending null
// clears one. Omitted fields are left unchanged.
const bodySchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  program: z.string().trim().min(1).max(100),
  year: z.string().trim().min(1).max(30),
  section: z.string().trim().min(1).max(30),
  semester: z.string().trim().min(1).max(60).nullable().optional(),
  semesterStartDate: z.iso.date().nullable().optional(),
  timezone: z.string().refine(isValidTimeZone, "Use an IANA timezone such as Asia/Kolkata").nullable().optional(),
});

const withWeek = (profile) => (profile ? { ...publicProfile(profile), academicWeek: academicWeek(profile, new Date()) } : null);

export async function handleProfile(request, { db, env = process.env } = {}) {
  if (!env.STUDENT_PROFILE_TABLE) return send(503, { error: { code: "NOT_CONFIGURED", message: "Profile setup is not connected yet." } });
  try {
    if (request.requestContext?.http?.method === "GET") {
      return send(200, { profile: withWeek(await loadProfile(db, env.STUDENT_PROFILE_TABLE)) });
    }
    if (request.requestContext?.http?.method === "PUT") {
      const body = bodySchema.safeParse(JSON.parse(request.body ?? ""));
      if (!body.success) return send(400, { error: { code: "INVALID_PROFILE", message: "Provide your name, program, year, and section.", details: body.error.issues.map((issue) => ({ field: issue.path.join("."), issue: issue.message })) } });
      // One atomic update: creates the profile if needed and touches only these
      // fields, so Classroom credentials, sync status, and planner state that
      // another request wrote in the meantime are never overwritten.
      const names = {};
      const values = { ":empty": [] };
      const sets = ["connectedCourses = if_not_exists(connectedCourses, :empty)", "timetableSlots = if_not_exists(timetableSlots, :empty)"];
      const removes = [];
      for (const [field, value] of Object.entries(body.data)) {
        names[`#${field}`] = field;
        if (value === null) removes.push(`#${field}`);
        else { values[`:${field}`] = value; sets.push(`#${field} = :${field}`); }
      }
      await db.send(new UpdateCommand({
        TableName: env.STUDENT_PROFILE_TABLE, Key: { userId: "demo-user" },
        UpdateExpression: `SET ${sets.join(", ")}${removes.length ? ` REMOVE ${removes.join(", ")}` : ""}`,
        ExpressionAttributeNames: names, ExpressionAttributeValues: values,
      }));
      return send(200, { profile: withWeek(await loadProfile(db, env.STUDENT_PROFILE_TABLE)) });
    }
    return send(404, { error: { code: "NOT_FOUND", message: "This endpoint does not exist." } });
  } catch {
    return send(400, { error: { code: "INVALID_PROFILE", message: "Provide your name, program, year, and section." } });
  }
}
export const handler = (request) => handleProfile(request, { db });
