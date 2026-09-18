import { createHmac, timingSafeEqual } from "node:crypto";
import { classroom_v1 } from "googleapis/build/src/apis/classroom/v1.js";
import { OAuth2Client } from "google-auth-library";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { studentProfileSchema } from "./contracts.js";
import { DEMO_USER_ID, ingestNotice } from "./ingestion.js";
import { IngestionError } from "./errors.js";

const scopes = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.announcements.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
  "https://www.googleapis.com/auth/classroom.profile.emails",
];
const base64url = (value) => Buffer.from(value).toString("base64url");
const decode = (value) => Buffer.from(value, "base64url").toString("utf8");
const signature = (payload, secret) => createHmac("sha256", secret).update(payload).digest("base64url");

export function createState(secret, now = Date.now()) {
  if (!secret || secret.length < 32) throw new IngestionError(503, "NOT_CONFIGURED", "Google Classroom is not configured yet.");
  const payload = base64url(JSON.stringify({ userId: DEMO_USER_ID, issuedAt: now, nonce: base64url(crypto.getRandomValues(new Uint8Array(16))) }));
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyState(state, secret, now = Date.now()) {
  const [payload, supplied] = (state ?? "").split(".");
  if (!payload || !supplied || !secret) throw new IngestionError(400, "INVALID_OAUTH_STATE", "The Classroom connection has expired. Start again.");
  const expected = signature(payload, secret);
  if (supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new IngestionError(400, "INVALID_OAUTH_STATE", "The Classroom connection has expired. Start again.");
  let data;
  try { data = JSON.parse(decode(payload)); } catch { throw new IngestionError(400, "INVALID_OAUTH_STATE", "The Classroom connection has expired. Start again."); }
  if (data.userId !== DEMO_USER_ID || !Number.isSafeInteger(data.issuedAt) || now - data.issuedAt > 10 * 60_000 || data.issuedAt > now + 60_000) throw new IngestionError(400, "INVALID_OAUTH_STATE", "The Classroom connection has expired. Start again.");
  return data;
}

export function oauthClient(env, OAuth2 = OAuth2Client) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) throw new IngestionError(503, "NOT_CONFIGURED", "Google Classroom is not configured yet.");
  return new OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI);
}

async function profile(db, tableName) {
  const result = await db.send(new GetCommand({ TableName: tableName, Key: { userId: DEMO_USER_ID }, ConsistentRead: true }));
  if (!result.Item) throw new IngestionError(409, "PROFILE_REQUIRED", "Save your student profile before connecting Google Classroom.");
  return studentProfileSchema.parse(result.Item);
}

export async function storeTokens(db, tableName, tokens) {
  const current = await profile(db, tableName);
  const next = { accessToken: tokens.access_token ?? current.classroomTokens?.accessToken, refreshToken: tokens.refresh_token ?? current.classroomTokens?.refreshToken, expiresAt: tokens.expiry_date ?? current.classroomTokens?.expiresAt };
  if (!next.accessToken || !next.refreshToken || !Number.isSafeInteger(next.expiresAt)) throw new IngestionError(502, "GOOGLE_TOKEN_ERROR", "Google did not return a reusable connection. Remove CampusFlow in Google account permissions, then connect again.");
  await db.send(new UpdateCommand({ TableName: tableName, Key: { userId: DEMO_USER_ID }, UpdateExpression: "SET classroomTokens = :tokens", ExpressionAttributeValues: { ":tokens": next } }));
  return next;
}

export async function connectedClient({ db, env, OAuth2 = OAuth2Client }) {
  const current = await profile(db, env.STUDENT_PROFILE_TABLE);
  if (!current.classroomTokens) throw new IngestionError(409, "CLASSROOM_NOT_CONNECTED", "Connect Google Classroom first.");
  const client = oauthClient(env, OAuth2);
  client.setCredentials({ access_token: current.classroomTokens.accessToken, refresh_token: current.classroomTokens.refreshToken, expiry_date: current.classroomTokens.expiresAt });
  client.on("tokens", async (tokens) => { try { await storeTokens(db, env.STUDENT_PROFILE_TABLE, tokens); } catch { /* the API request still owns its response */ } });
  return { client, profile: current };
}

export async function allPages(call, field) {
  const values = [];
  let pageToken;
  do {
    const page = await call(pageToken);
    values.push(...(page.data[field] ?? []));
    pageToken = page.data.nextPageToken;
  } while (pageToken);
  return values;
}

const safe = (value) => String(value ?? "").replace(/[\r\n]+/g, " ").trim();
const courseworkDeadline = (item) => item.dueDate ? `${item.dueDate.year}-${String(item.dueDate.month).padStart(2, "0")}-${String(item.dueDate.day).padStart(2, "0")}T${String(item.dueTime?.hours ?? 23).padStart(2, "0")}:${String(item.dueTime?.minutes ?? 59).padStart(2, "0")}` : "no deadline";
export function classroomText(course, item, kind) {
  if (kind === "coursework") return `[Classroom] ${safe(course.name)}: Coursework '${safe(item.title)}'${item.description ? ` — ${safe(item.description)}` : ""}; due ${courseworkDeadline(item)}.`;
  return `[Classroom] ${safe(course.name)}: Announcement '${safe(item.text)}'.`;
}

export async function syncClassroom({ db, ai, bedrock, env, Classroom = classroom_v1.Classroom, OAuth2 = OAuth2Client, now = () => new Date() }) {
  const { client, profile: current } = await connectedClient({ db, env, OAuth2 });
  const api = new Classroom({ auth: client });
  let processed = 0;
  for (const courseId of current.connectedCourses) {
    const sync = await db.send(new GetCommand({ TableName: env.CLASSROOM_SYNC_STATE_TABLE, Key: { userId: DEMO_USER_ID, courseId }, ConsistentRead: true }));
    const floor = sync.Item?.lastSyncedAt;
    const course = (await api.courses.get({ id: courseId })).data;
    const [announcements, coursework] = await Promise.all([
      allPages((pageToken) => api.courses.announcements.list({ courseId, pageSize: 100, pageToken }), "announcements"),
      allPages((pageToken) => api.courses.courseWork.list({ courseId, pageSize: 100, pageToken, orderBy: "updateTime asc" }), "courseWork"),
    ]);
    const items = [
      ...announcements.map((item) => ({ item, kind: "announcement" })),
      ...coursework.map((item) => ({ item, kind: "coursework" })),
    ].filter(({ item }) => !floor || Date.parse(item.updateTime) > Date.parse(floor)).sort((a, b) => Date.parse(a.item.updateTime) - Date.parse(b.item.updateTime));
    for (const { item, kind } of items) {
      const sourceRef = `${courseId}:${kind}:${item.id}`;
      await ingestNotice({ text: classroomText(course, item, kind), sourceType: "classroom", sourceRef }, { db, ai, bedrock, env, tableName: env.ACADEMIC_EVENTS_TABLE, profileTableName: env.STUDENT_PROFILE_TABLE, modelId: env.BEDROCK_MODEL_ID, now });
      processed++;
    }
    const newest = [...announcements, ...coursework].map((item) => item.updateTime).filter(Boolean).sort().at(-1);
    if (newest && (!floor || Date.parse(newest) > Date.parse(floor))) await db.send(new PutCommand({ TableName: env.CLASSROOM_SYNC_STATE_TABLE, Item: { userId: DEMO_USER_ID, courseId, lastSyncedAt: newest } }));
  }
  return { processed };
}
