import { createHmac, timingSafeEqual } from "node:crypto";
import { classroom_v1 } from "googleapis/build/src/apis/classroom/v1.js";
import { OAuth2Client } from "google-auth-library";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { studentProfileSchema } from "./contracts.js";
import { DEMO_USER_ID, ingestNotice, noticeRevision } from "./ingestion.js";
import { classroomSourceUrl, syncFailureCategory } from "./source-truth.js";
import { IngestionError } from "./errors.js";
import { campusDateTime } from "./time.js";

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
// The Classroom API reports dueDate and dueTime in UTC, while the prompt speaks
// campus-local time, so the instant is converted rather than its fields copied.
// Google omits zero-valued fields, so a present dueTime defaults each part to 0.
// dueTime accompanies every dueDate per the API; the end-of-day fallback only
// covers a malformed item.
const courseworkDeadline = (item) => {
  if (!item.dueDate) return "no deadline";
  const { year, month, day } = item.dueDate;
  if (!item.dueTime) return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T23:59`;
  return campusDateTime(Date.UTC(year, month - 1, day, item.dueTime.hours ?? 0, item.dueTime.minutes ?? 0));
};
// Attached forms, sheets, files, and links are often where the work happens,
// so their titles and URLs travel with the text.
function materialsText(item) {
  const entries = (item.materials ?? []).map((material) => {
    if (material.form) return ["Form", material.form.title, material.form.formUrl];
    if (material.link) return ["Link", material.link.title, material.link.url];
    if (material.driveFile?.driveFile) return ["File", material.driveFile.driveFile.title, material.driveFile.driveFile.alternateLink];
    if (material.youtubeVideo) return ["Video", material.youtubeVideo.title, material.youtubeVideo.alternateLink];
    return null;
  }).filter((entry) => entry && entry[2]).slice(0, 10);
  return entries.length ? ` Materials: ${entries.map(([kind, title, url]) => `${kind}${title ? ` '${safe(title)}'` : ""} ${safe(url)}`).join("; ")}.` : "";
}

export function classroomText(course, item, kind) {
  if (kind === "coursework") return `[Classroom] ${safe(course.name)}: Coursework '${safe(item.title)}'${item.description ? ` — ${safe(item.description)}` : ""}; due ${courseworkDeadline(item)}.${materialsText(item)}`;
  return `[Classroom] ${safe(course.name)}: Announcement '${safe(item.text)}'.${materialsText(item)}`;
}

const validTime = (value) => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null);

export const emptySyncResult = () => ({
  coursesScanned: 0, announcementsScanned: 0, courseworkScanned: 0, processed: 0, created: 0, updated: 0, cancelled: 0, ignored: 0, failed: 0, truncated: false,
  ignoredReasons: { modelIgnored: 0, alreadyProcessed: 0, duplicate: 0, noChange: 0 },
  rateLimited: false,
  temporaryFailed: 0, validationFailed: 0, raceSkipped: 0, needsReview: 0, reviewItems: [],
});
const ACTION_COUNTER = { CREATE: "created", UPDATE: "updated", CANCEL: "cancelled", IGNORE: "ignored" };

// One source item may yield several results; each is counted, and every
// ignore carries its reason.
function count(result, outcome) {
  for (const item of outcome.results ?? [outcome]) {
    if (!ACTION_COUNTER[item.action]) continue;
    result[ACTION_COUNTER[item.action]]++;
    if (item.action === "IGNORE") {
      const reason = item.reason in result.ignoredReasons ? item.reason : "modelIgnored";
      result.ignoredReasons[reason]++;
    }
  }
}

// budgetMs bounds how long the run may keep starting new items. A truncated
// course keeps its watermark, so the next run resumes it; ingestion is
// idempotent, so replaying already-processed items cannot duplicate anything.
export async function syncClassroom({ db, ai, bedrock, env, Classroom = classroom_v1.Classroom, OAuth2 = OAuth2Client, now = () => new Date(), budgetMs = Number.POSITIVE_INFINITY, startedAt = Date.now() }) {
  const { client, profile: current } = await connectedClient({ db, env, OAuth2 });
  const api = new Classroom({ auth: client });
  const result = emptySyncResult();
  const courseReviews = new Map();
  const outOfTime = () => Date.now() - startedAt > budgetMs;
  for (const courseId of current.connectedCourses) {
    if (outOfTime() || result.rateLimited) { result.truncated = true; break; }
    const sync = await db.send(new GetCommand({ TableName: env.CLASSROOM_SYNC_STATE_TABLE, Key: { userId: DEMO_USER_ID, courseId }, ConsistentRead: true }));
    const floor = sync.Item?.lastSyncedAt;
    const reviews = new Map((sync.Item?.reviewItems ?? []).map((entry) => [entry.sourceRef, entry]));
    const processed = new Map((sync.Item?.processedItems ?? []).map((entry) => [entry.sourceRef, entry]));
    const course = (await api.courses.get({ id: courseId })).data;
    const courseName = course.name ?? null;
    const [announcements, coursework] = await Promise.all([
      allPages((pageToken) => api.courses.announcements.list({ courseId, pageSize: 100, pageToken }), "announcements"),
      allPages((pageToken) => api.courses.courseWork.list({ courseId, pageSize: 100, pageToken, orderBy: "updateTime asc" }), "courseWork"),
    ]);
    result.coursesScanned++;
    result.announcementsScanned += announcements.length;
    result.courseworkScanned += coursework.length;
    const items = [
      ...announcements.map((item) => ({ item, kind: "announcement" })),
      ...coursework.map((item) => ({ item, kind: "coursework" })),
    ].filter(({ item }) => !floor || Date.parse(item.updateTime) > Date.parse(floor)).sort((a, b) => Date.parse(a.item.updateTime) - Date.parse(b.item.updateTime));
    // One unparseable announcement must not abandon the rest of the course.
    // ingestNotice is idempotent per source item (UUID v5 over the notice text),
    // so replaying a course after a failure cannot duplicate an event. Items
    // run one at a time: the model call is the rate-limited resource.
    let courseFailed = false;
    let courseTruncated = false;
    for (const { item, kind } of items) {
      if (outOfTime()) { courseTruncated = true; result.truncated = true; break; }
      const sourceRef = `${courseId}:${kind}:${item.id}`;
      const notice = {
        text: classroomText(course, item, kind), sourceType: "classroom", sourceRef,
        postedAt: validTime(item.creationTime), updatedAt: validTime(item.updateTime),
        sourceUrl: classroomSourceUrl(item.alternateLink),
      };
      const revision = noticeRevision(notice);
      if (reviews.get(sourceRef)?.revision === revision || processed.get(sourceRef)?.revision === revision) {
        result.ignored++; result.ignoredReasons.alreadyProcessed++; continue;
      }
      const recordFailure = (code) => {
        const category = syncFailureCategory(code);
        if (category === "needsReview" && (reviews.has(sourceRef) || reviews.size < 100)) {
          reviews.set(sourceRef, { sourceRef, revision, updatedAt: notice.updatedAt ?? now().toISOString(), code, sourceUrl: notice.sourceUrl });
          return;
        }
        result[category === "needsReview" ? "temporaryFailed" : category]++;
        courseFailed = true;
      };
      try {
        const outcome = await ingestNotice(notice, { db, ai, bedrock, env, tableName: env.ACADEMIC_EVENTS_TABLE, profileTableName: env.STUDENT_PROFILE_TABLE, modelId: env.BEDROCK_MODEL_ID, now, taskContext: { courseName } });
        result.processed++;
        count(result, outcome);
        // Some items of the post failed: keep the watermark so a replay, which
        // skips what already landed, fills the gap.
        if (outcome.partial) {
          result.failed++;
          const failures = outcome.results.filter((entry) => entry.action === "FAILED");
          const retryable = failures.find((entry) => syncFailureCategory(entry.code) !== "needsReview");
          recordFailure((retryable ?? failures[0]).code);
        } else {
          reviews.delete(sourceRef);
          processed.set(sourceRef, { sourceRef, revision });
        }
      } catch (error) {
        result.failed++;
        recordFailure(error?.code ?? "UNKNOWN");
        // Never log notice text, model output, or credentials: codes only.
        console.error(JSON.stringify({ code: "CLASSROOM_ITEM_FAILED", courseId, kind, itemId: item.id, reason: error?.code ?? error?.name ?? "UNKNOWN" }));
        // Groq is still limiting after bounded retries: stop this run instead
        // of failing every remaining item. Watermarks hold, so the next run
        // resumes exactly here.
        if (error?.code === "RATE_LIMITED") { result.rateLimited = true; courseTruncated = true; result.truncated = true; break; }
      }
    }
    // The watermark only advances after a clean, complete pass of this course,
    // so a failed item is retried next cycle instead of being skipped for good.
    // Failures are tracked per course: one bad course never holds back another.
    const newest = [...announcements, ...coursework].map((item) => item.updateTime).filter(Boolean).sort().at(-1);
    const advance = !courseFailed && !courseTruncated && newest && (!floor || Date.parse(newest) > Date.parse(floor));
    // The course name is kept beside the watermark so Tasks can show it.
    // Review holds a source revision, not the entire course watermark. An edit
    // changes its revision and is tried again. Successful receipts avoid paying
    // for repeated IGNORE extractions while another item remains retryable.
    const reviewItems = [...reviews.values()];
    courseReviews.set(courseId, reviewItems);
    const processedItems = advance ? [] : [...processed.values()].slice(-500);
    if (advance || reviewItems.length || processedItems.length || (floor && (sync.Item?.courseName ?? null) !== courseName)
      || JSON.stringify(reviewItems) !== JSON.stringify(sync.Item?.reviewItems ?? [])) {
      await db.send(new PutCommand({ TableName: env.CLASSROOM_SYNC_STATE_TABLE, Item: { userId: DEMO_USER_ID, courseId, lastSyncedAt: advance ? newest : floor ?? "1970-01-01T00:00:00.000Z", courseName, reviewItems, processedItems } }));
    }
  }
  // A truncated run must still expose reviews from courses it did not reach.
  for (const courseId of current.connectedCourses) {
    if (!courseReviews.has(courseId)) {
      const state = await db.send(new GetCommand({ TableName: env.CLASSROOM_SYNC_STATE_TABLE, Key: { userId: DEMO_USER_ID, courseId }, ConsistentRead: true }));
      courseReviews.set(courseId, state.Item?.reviewItems ?? []);
    }
    const reviews = courseReviews.get(courseId);
    result.needsReview += reviews.length;
    result.reviewItems.push(...reviews.map(({ sourceRef, code, sourceUrl }) => ({ courseId, sourceRef, code, sourceUrl })));
  }
  // Label the connected account once; a failure here never fails the sync.
  if (!current.classroomAccount) {
    try {
      const me = (await api.userProfiles.get({ userId: "me" })).data;
      result.account = { email: me.emailAddress ?? null, name: me.name?.fullName ?? null };
    } catch { /* optional metadata */ }
  }
  return result;
}
