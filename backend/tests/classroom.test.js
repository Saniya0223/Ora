import assert from "node:assert/strict";
import test from "node:test";
import { classroomText, createState, syncClassroom, verifyState } from "../lib/classroom.js";
import { handleClassroom } from "../handlers/classroom.js";

test("OAuth state is signed, user-bound, and expires", () => {
  const secret = "a".repeat(32);
  const state = createState(secret, 1_000);
  assert.equal(verifyState(state, secret, 2_000).userId, "demo-user");
  assert.throws(() => verifyState(`${state}x`, secret, 2_000), /expired/);
  assert.throws(() => verifyState(state, secret, 11 * 60_000), /expired/);
});

test("Classroom messages include a source label, course context, and a local due time", () => {
  const course = { name: "CS301" };
  assert.equal(classroomText(course, { title: "Lab 4", dueDate: { year: 2026, month: 9, day: 20 }, dueTime: { hours: 18, minutes: 30 } }, "coursework"), "[Classroom] CS301: Coursework 'Lab 4'; due 2026-09-21T00:00.");
  assert.equal(classroomText(course, { text: "Class cancelled" }, "announcement"), "[Classroom] CS301: Announcement 'Class cancelled'.");
});

test("Classroom due times are UTC and reach the prompt as campus-local time", () => {
  const course = { name: "DSA" };
  const due = (dueTime) => classroomText(course, { title: "A", dueDate: { year: 2026, month: 9, day: 21 }, ...(dueTime === undefined ? {} : { dueTime }) }, "coursework");
  // Classroom stores an 11:59 PM IST deadline as 18:29 UTC.
  assert.equal(due({ hours: 18, minutes: 29 }), "[Classroom] DSA: Coursework 'A'; due 2026-09-21T23:59.");
  // A UTC evening crosses into the next campus day.
  assert.equal(due({ hours: 20, minutes: 0 }), "[Classroom] DSA: Coursework 'A'; due 2026-09-22T01:30.");
  // Google omits zero fields: {} is 00:00 UTC, not a missing time.
  assert.equal(due({}), "[Classroom] DSA: Coursework 'A'; due 2026-09-21T05:30.");
  assert.equal(due({ minutes: 15 }), "[Classroom] DSA: Coursework 'A'; due 2026-09-21T05:45.");
  // No dueTime at all keeps the end-of-day fallback.
  assert.equal(due(undefined), "[Classroom] DSA: Coursework 'A'; due 2026-09-21T23:59.");
});

test("the OAuth start endpoint uses the required read-only scopes and signed state", async () => {
  let options;
  class FakeOAuth {
    generateAuthUrl(value) { options = value; return "https://accounts.example.test/authorize"; }
  }
  const env = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_REDIRECT_URI: "https://api.example.test/classroom/callback", OAUTH_STATE_SECRET: "s".repeat(32) };
  const response = await handleClassroom({ rawPath: "/classroom/connect", requestContext: { http: { method: "GET" } } }, { env, db: {}, OAuth2: FakeOAuth });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).url, "https://accounts.example.test/authorize");
  assert.equal(verifyState(options.state, env.OAUTH_STATE_SECRET).userId, "demo-user");
  assert.deepEqual(options.scope, [
    "https://www.googleapis.com/auth/classroom.courses.readonly",
    "https://www.googleapis.com/auth/classroom.announcements.readonly",
    "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
    "https://www.googleapis.com/auth/classroom.profile.emails",
  ]);
  const alias = await handleClassroom({ rawPath: "/classroom/auth/start", requestContext: { http: { method: "GET" } } }, { env, db: {}, OAuth2: FakeOAuth });
  assert.equal(alias.statusCode, 200);
});

test("the selected-course endpoint accepts browser CORS preflight", async () => {
  const response = await handleClassroom(
    { rawPath: "/classroom/courses", requestContext: { http: { method: "OPTIONS" } } },
    { env: {}, db: {} },
  );
  assert.equal(response.statusCode, 204);
  assert.equal(response.body, "");
});

test("scheduled Classroom pagination sends each updated item through shared ingestion before checkpointing", async () => {
  const profile = {
    userId: "demo-user", name: "Demo", program: "CS", year: "3", section: "A",
    classroomTokens: { accessToken: "access", refreshToken: "refresh", expiresAt: 1_800_000_000_000 },
    connectedCourses: ["course-1"], timetableSlots: [],
  };
  const events = new Map();
  const checkpoints = new Map();
  const db = { async send(command) {
    const input = command.input;
    if (command.constructor.name === "GetCommand") {
      if (input.TableName === "profiles") return { Item: input.ProjectionExpression
        ? { name: profile.name, program: profile.program, year: profile.year, section: profile.section }
        : structuredClone(profile) };
      if (input.TableName === "sync") return { Item: checkpoints.get(input.Key.courseId) };
      return { Item: events.get(input.Key.eventId) };
    }
    if (command.constructor.name === "QueryCommand") return { Items: [...events.values()].map((event) => structuredClone(event)) };
    if (command.constructor.name === "PutCommand") {
      if (input.TableName === "sync") checkpoints.set(input.Item.courseId, structuredClone(input.Item));
      else events.set(input.Item.eventId, structuredClone(input.Item));
      return {};
    }
    throw new Error(`Unexpected ${command.constructor.name}`);
  } };
  let resolutions = 0;
  const bedrock = { async send() {
    resolutions++;
    return { stopReason: "end_turn", output: { message: { content: [{ text: JSON.stringify({
      action: "CREATE", targetEventId: null,
      eventDetails: { title: `Classroom item ${resolutions}`, type: "Assignment", currentDeadline: `2026-09-2${resolutions}T17:00`, venue: "", estimatedHours: 1 },
      changeSummary: "Imported from Classroom",
    }) }] } } };
  } };
  class FakeOAuth { setCredentials() {} on() {} }
  class FakeClassroom {
    constructor() {
      this.courses = {
        get: async () => ({ data: { name: "CS301" } }),
        announcements: { list: async ({ pageToken }) => pageToken
          ? { data: { announcements: [{ id: "announcement-2", text: "Second update", updateTime: "2026-09-17T10:02:00.000Z" }] } }
          : { data: { announcements: [{ id: "announcement-1", text: "First update", updateTime: "2026-09-17T10:01:00.000Z" }], nextPageToken: "page-2" } } },
        courseWork: { list: async () => ({ data: { courseWork: [{ id: "work-1", title: "Lab 4", updateTime: "2026-09-17T10:03:00.000Z", dueDate: { year: 2026, month: 9, day: 23 } }] } }) },
      };
    }
  }
  const result = await syncClassroom({
    db, bedrock, Classroom: FakeClassroom, OAuth2: FakeOAuth,
    env: {
      STUDENT_PROFILE_TABLE: "profiles", ACADEMIC_EVENTS_TABLE: "events", CLASSROOM_SYNC_STATE_TABLE: "sync", BEDROCK_MODEL_ID: "model", bedrock,
      GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_REDIRECT_URI: "https://api.example.test/classroom/callback",
    },
    now: () => new Date("2026-09-17T04:30:00.000Z"),
  });
  assert.equal(result.processed, 3);
  assert.equal(events.size, 3);
  assert.equal(checkpoints.get("course-1").lastSyncedAt, "2026-09-17T10:03:00.000Z");
});

test("one failing Classroom item is isolated, holds the checkpoint, and replays without duplicating", async () => {
  const profile = {
    userId: "demo-user", name: "Demo", program: "CS", year: "3", section: "A",
    classroomTokens: { accessToken: "access", refreshToken: "refresh", expiresAt: 1_800_000_000_000 },
    connectedCourses: ["course-1"], timetableSlots: [],
  };
  const events = new Map();
  const checkpoints = new Map();
  const db = { async send(command) {
    const input = command.input;
    if (command.constructor.name === "GetCommand") {
      if (input.TableName === "profiles") return { Item: input.ProjectionExpression
        ? { name: profile.name, program: profile.program, year: profile.year, section: profile.section }
        : structuredClone(profile) };
      if (input.TableName === "sync") return { Item: checkpoints.get(input.Key.courseId) };
      return { Item: events.get(input.Key.eventId) };
    }
    if (command.constructor.name === "QueryCommand") return { Items: [...events.values()].map((event) => structuredClone(event)) };
    if (command.constructor.name === "PutCommand") {
      if (input.TableName === "sync") checkpoints.set(input.Item.courseId, structuredClone(input.Item));
      else events.set(input.Item.eventId, structuredClone(input.Item));
      return {};
    }
    throw new Error(`Unexpected ${command.constructor.name}`);
  } };
  // The second announcement always fails extraction; the others must still land.
  const ai = { name: "groq", async generateStructured({ prompt }) {
    // Match on the incoming notice line only: the prompt also carries the
    // existing-events JSON, which already contains earlier titles.
    const notice = prompt.split("[Classroom]").at(-1);
    if (notice.includes("Poison")) throw new Error("model failure");
    const title = notice.includes("Coursework") ? "Lab 4" : "First task";
    return { action: "CREATE", targetEventId: null, changeSummary: "Imported from Classroom",
      eventDetails: { title, type: "Assignment", currentDeadline: "2026-09-23T17:00", venue: "", estimatedHours: 1 } };
  } };
  class FakeOAuth { setCredentials() {} on() {} }
  class FakeClassroom {
    constructor() {
      this.courses = {
        get: async () => ({ data: { name: "CS301" } }),
        announcements: { list: async () => ({ data: { announcements: [
          { id: "announcement-1", text: "First update", updateTime: "2026-09-17T10:01:00.000Z" },
          { id: "announcement-2", text: "Poison update", updateTime: "2026-09-17T10:02:00.000Z" },
        ] } }) },
        courseWork: { list: async () => ({ data: { courseWork: [{ id: "work-1", title: "Lab 4", updateTime: "2026-09-17T10:03:00.000Z", dueDate: { year: 2026, month: 9, day: 23 } }] } }) },
      };
    }
  }
  const env = {
    STUDENT_PROFILE_TABLE: "profiles", ACADEMIC_EVENTS_TABLE: "events", CLASSROOM_SYNC_STATE_TABLE: "sync",
    GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_REDIRECT_URI: "https://api.example.test/classroom/callback",
  };
  const run = () => syncClassroom({ db, ai, env, Classroom: FakeClassroom, OAuth2: FakeOAuth, now: () => new Date("2026-09-17T04:30:00.000Z") });

  const first = await run();
  assert.equal(first.processed, 2, "the two healthy items still ingest");
  assert.equal(first.failed, 1, "the poison item is counted, not thrown");
  assert.equal(events.size, 2);
  assert.equal(checkpoints.get("course-1").lastSyncedAt, "1970-01-01T00:00:00.000Z", "a failed item must not advance the watermark");

  // The 15-minute scheduler replays the same items: ingestion is idempotent.
  const second = await run();
  assert.equal(second.processed, 0, "successful receipts skip repeat extraction");
  assert.equal(second.ignoredReasons.alreadyProcessed, 2);
  assert.equal(second.failed, 1);
  assert.equal(events.size, 2, "a replayed sync must not duplicate events");
});
