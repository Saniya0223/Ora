import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { classroom_v1 } from "googleapis/build/src/apis/classroom/v1.js";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { db, bedrock } from "../lib/clients.js";
import { allPages, connectedClient, createState, oauthClient, storeTokens, verifyState } from "../lib/classroom.js";
import { runClassroomSync } from "../lib/classroom-run.js";
import { IngestionError } from "../lib/errors.js";

const json = (statusCode, body) => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) });
export async function handleClassroom(request, dependencies) {
  const env = dependencies.env ?? process.env;
  try {
    const method = request.requestContext?.http?.method;
    const path = request.rawPath;
    if (method === "OPTIONS" && ["/classroom/courses", "/classroom/sync"].includes(path)) {
      return { statusCode: 204, headers: { "cache-control": "no-store" }, body: "" };
    }
    if (method === "GET" && ["/classroom/connect", "/classroom/auth/start"].includes(path)) {
      const client = oauthClient(env, dependencies.OAuth2 ?? OAuth2Client);
      return json(200, { url: client.generateAuthUrl({ access_type: "offline", prompt: "consent", include_granted_scopes: true, scope: ["https://www.googleapis.com/auth/classroom.courses.readonly", "https://www.googleapis.com/auth/classroom.announcements.readonly", "https://www.googleapis.com/auth/classroom.coursework.me.readonly", "https://www.googleapis.com/auth/classroom.profile.emails"], state: createState(env.OAUTH_STATE_SECRET) }) });
    }
    if (method === "GET" && path === "/classroom/callback") {
      const query = request.queryStringParameters ?? {};
      if (query.error) throw new IngestionError(400, "GOOGLE_DENIED", "Google Classroom access was not granted.");
      verifyState(query.state, env.OAUTH_STATE_SECRET);
      if (!query.code) throw new IngestionError(400, "INVALID_CALLBACK", "Google did not return a connection code.");
      const client = oauthClient(env, dependencies.OAuth2 ?? OAuth2Client);
      const token = await client.getToken(query.code);
      await storeTokens(dependencies.db, env.STUDENT_PROFILE_TABLE, token.tokens);
      return { statusCode: 302, headers: { location: env.FRONTEND_URL ? `${env.FRONTEND_URL}/?classroom=connected` : "/" }, body: "" };
    }
    if (method === "GET" && path === "/classroom/courses") {
      const { client } = await connectedClient({ db: dependencies.db, env, OAuth2: dependencies.OAuth2 ?? OAuth2Client });
      const Classroom = dependencies.Classroom ?? classroom_v1.Classroom;
      const api = new Classroom({ auth: client });
      const courses = await allPages((pageToken) => api.courses.list({ studentId: "me", courseStates: ["ACTIVE"], pageSize: 100, pageToken }), "courses");
      return json(200, { courses: courses.map(({ id, name, section }) => ({ id, name, section: section ?? "" })) });
    }
    // Sync Now. Runs the same production sync as the 15-minute scheduler, with a
    // time budget that fits the API timeout; unfinished work resumes next run.
    if (method === "POST" && path === "/classroom/sync") {
      const run = dependencies.runSync ?? runClassroomSync;
      let outcome;
      try {
        outcome = await run({ db: dependencies.db, bedrock: dependencies.bedrock, ai: dependencies.ai, env }, { trigger: "manual", budgetMs: 20_000, enrich: false });
      } catch (error) {
        const status = error.syncStatus;
        if (status?.status === "REAUTH_REQUIRED") return json(409, { error: { code: "REAUTH_REQUIRED", message: "Reconnect Google Classroom to keep syncing." }, sync: status });
        return json(502, { error: { code: "SYNC_FAILED", message: "Google Classroom could not be synced. Please try again." }, ...(status ? { sync: status } : {}) });
      }
      if (outcome.skipped === "DISCONNECTED") return json(409, { error: { code: "CLASSROOM_NOT_CONNECTED", message: "Connect Google Classroom and choose courses first." } });
      if (outcome.skipped === "IN_PROGRESS") return json(409, { error: { code: "SYNC_IN_PROGRESS", message: "A sync is already running. Check back in a moment." } });
      return json(200, { sync: outcome });
    }
    if (method === "PUT" && path === "/classroom/courses") {
      const body = z.strictObject({ courseIds: z.array(z.string().min(1)).max(100) }).safeParse(JSON.parse(request.body ?? ""));
      if (!body.success) throw new IngestionError(400, "INVALID_COURSES", "Choose valid Classroom courses.");
      await dependencies.db.send(new UpdateCommand({ TableName: env.STUDENT_PROFILE_TABLE, Key: { userId: "demo-user" }, UpdateExpression: "SET connectedCourses = :courses", ConditionExpression: "attribute_exists(userId) AND attribute_exists(classroomTokens)", ExpressionAttributeValues: { ":courses": [...new Set(body.data.courseIds)] } }));
      return json(200, { connectedCourses: [...new Set(body.data.courseIds)] });
    }
    return json(404, { error: { code: "NOT_FOUND", message: "This endpoint does not exist." } });
  } catch (error) {
    if (error instanceof IngestionError) return json(error.statusCode, { error: { code: error.code, message: error.message } });
    if (error.name === "ConditionalCheckFailedException") return json(409, { error: { code: "CLASSROOM_NOT_CONNECTED", message: "Connect Google Classroom first." } });
    console.error(JSON.stringify({ code: "CLASSROOM_ERROR", requestId: request.requestContext?.requestId }));
    return json(503, { error: { code: "CLASSROOM_UNAVAILABLE", message: "Google Classroom is unavailable. Please try again." } });
  }
}
export const handler = (request) => handleClassroom(request, { db, bedrock });
export const schedulerHandler = async () => runClassroomSync({ db, bedrock, env: process.env }, { trigger: "scheduled" });
