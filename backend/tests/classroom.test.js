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
  assert.equal(classroomText(course, { title: "Lab 4", dueDate: { year: 2026, month: 9, day: 20 }, dueTime: { hours: 18, minutes: 30 } }, "coursework"), "[Classroom] CS301: Coursework 'Lab 4'; due 2026-09-20T18:30.");
  assert.equal(classroomText(course, { text: "Class cancelled" }, "announcement"), "[Classroom] CS301: Announcement 'Class cancelled'.");
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
