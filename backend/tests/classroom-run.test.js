import assert from "node:assert/strict";
import test from "node:test";
import { runClassroomSync, classifySyncError } from "../lib/classroom-run.js";
import { handleClassroom } from "../handlers/classroom.js";
import { standardEnv, standardTables } from "./helpers/fake-dynamo.js";

const now = new Date("2026-09-18T04:30:00.000Z");
const GOOGLE = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_REDIRECT_URI: "https://api.example.test/classroom/callback" };
const env = { ...standardEnv, ...GOOGLE };

// A profile carrying every newly added field. The sync parses the profile
// strictly, so this guards against a new field silently breaking live sync.
function fullProfile(overrides = {}) {
  return {
    userId: "demo-user", name: "Maya", program: "CS", year: "3", section: "A",
    classroomTokens: { accessToken: "a", refreshToken: "r", expiresAt: 1_900_000_000_000 },
    connectedCourses: ["c1"], timetableSlots: [],
    semester: "Spring 2026", semesterStartDate: "2026-08-03", timezone: "Asia/Kolkata",
    planning: { dailyStudyHours: 4, preferredStudyStart: "18:00", preferredStudyEnd: "23:00", autoScheduleStudyBlocks: true, avoidClassConflicts: true },
    timetableSource: { kind: "MANUAL", fileName: null, jobId: null, importedAt: now.toISOString(), updatedAt: now.toISOString() },
    planningState: { fingerprint: "x", capacity: { atRisk: false, items: [] } },
    ...overrides,
  };
}

class FakeOAuth { setCredentials() {} on() {} }
function fakeClassroom(courses) {
  return class {
    constructor() {
      this.userProfiles = { get: async () => ({ data: { emailAddress: "maya@college.edu", name: { fullName: "Maya Lin" } } }) };
      this.courses = {
        get: async ({ id }) => { if (courses[id].error) throw courses[id].error; return { data: { name: courses[id].name } }; },
        announcements: { list: async ({ courseId }) => ({ data: { announcements: courses[courseId].announcements ?? [] } }) },
        courseWork: { list: async ({ courseId }) => ({ data: { courseWork: courses[courseId].coursework ?? [] } }) },
      };
    }
  };
}

// Groq stand-in: CREATE an event titled after the notice, fail on "Poison".
function groq(calls = []) {
  return {
    name: "groq",
    modelFor: (tier) => (tier === "reasoning" ? "openai/gpt-oss-120b" : "openai/gpt-oss-20b"),
    async generateStructured(request) {
      calls.push(request.tier ?? "extraction");
      if (request.tier === "reasoning") return { estimatedMinutes: 150, workUnits: [{ title: "Draft", minutes: 150 }], rationale: "One draft" };
      const notice = request.prompt.split("[Classroom]").at(-1);
      if (notice.includes("Poison")) throw new Error("model failure");
      const title = /'([^']+)'/.exec(notice)[1];
      return { action: "CREATE", targetEventId: null, changeSummary: "New", eventDetails: { title, type: "Assignment", currentDeadline: "2026-09-25T23:59", venue: null, estimatedHours: 0 } };
    },
  };
}

const work = (id, title, updateTime = "2026-09-17T10:00:00.000Z") => ({ id, title, updateTime, dueDate: { year: 2026, month: 9, day: 25 }, dueTime: { hours: 18, minutes: 29 } });

test("a scheduled sync records real status, labels courses, and turns coursework into Tasks", async () => {
  const db = standardTables().seed("profiles", fullProfile());
  const calls = [];
  const result = await runClassroomSync({ db, env, ai: groq(calls), Classroom: fakeClassroom({ c1: { name: "DSA", coursework: [work("w1", "Assignment 1")] } }), OAuth2: FakeOAuth, now: () => now });
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.lastResult.created, 1);
  assert.equal(result.lastResult.courseworkScanned, 1);
  const saved = db.get("profiles", { userId: "demo-user" });
  assert.equal(saved.classroomSync.status, "SUCCESS");
  assert.ok(saved.classroomSync.lastSuccessfulSyncAt);
  assert.equal(saved.classroomSyncLease, undefined, "the lease is released");
  assert.equal(saved.classroomAccount.email, "maya@college.edu");
  assert.equal(db.get("sync", { userId: "demo-user", courseId: "c1" }).courseName, "DSA");
  const [task] = db.all("tasks");
  assert.equal(task.title, "Assignment 1");
  assert.equal(task.course.name, "DSA");
  assert.equal(task.aiEstimate.estimatedMinutes, 150, "the unsized task was estimated after the sync");
  assert.equal(task.aiEstimate.model, "openai/gpt-oss-120b");
  assert.deepEqual(calls, ["extraction", "reasoning"], "20B extracts; 120B only estimates");

  const repeat = await runClassroomSync({ db, env, ai: groq(), Classroom: fakeClassroom({ c1: { name: "DSA", coursework: [work("w1", "Assignment 1")] } }), OAuth2: FakeOAuth, now: () => now });
  assert.equal(repeat.lastResult.processed, 0, "the watermark skips already-synced items");
  assert.equal(db.all("events").length, 1);
  assert.equal(db.all("tasks").length, 1);
});

test("a failing item makes the run PARTIAL, and one bad course never holds back another", async () => {
  const db = standardTables().seed("profiles", fullProfile({ connectedCourses: ["c1", "c2"] }));
  const Classroom = fakeClassroom({
    c1: { name: "Broken", coursework: [work("p1", "Poison task")] },
    c2: { name: "DSA", coursework: [work("w2", "Assignment 2", "2026-09-17T11:00:00.000Z")] },
  });
  const result = await runClassroomSync({ db, env, ai: groq(), Classroom, OAuth2: FakeOAuth, now: () => now }, { enrich: false });
  assert.equal(result.status, "PARTIAL");
  assert.equal(result.lastResult.failed, 1);
  assert.equal(result.lastResult.created, 1);
  assert.equal(db.get("sync", { userId: "demo-user", courseId: "c1" }), undefined, "the failed course keeps its watermark");
  assert.equal(db.get("sync", { userId: "demo-user", courseId: "c2" }).lastSyncedAt, "2026-09-17T11:00:00.000Z", "the healthy course advances");
});

test("an expired Google grant is recorded as REAUTH_REQUIRED without storing the raw error", async () => {
  const db = standardTables().seed("profiles", fullProfile());
  const denied = Object.assign(new Error("invalid_grant"), { response: { status: 400, data: { error: "invalid_grant", error_description: "Token has been expired or revoked." } } });
  const Classroom = fakeClassroom({ c1: { name: "DSA", error: denied } });
  await assert.rejects(() => runClassroomSync({ db, env, ai: groq(), Classroom, OAuth2: FakeOAuth, now: () => now }));
  const saved = db.get("profiles", { userId: "demo-user" });
  assert.equal(saved.classroomSync.status, "REAUTH_REQUIRED");
  assert.equal(saved.classroomSync.lastErrorCode, "REAUTH_REQUIRED");
  assert.equal(saved.classroomSyncLease, undefined);
  assert.ok(!JSON.stringify(saved.classroomSync).includes("revoked"));
  assert.equal(classifySyncError(Object.assign(new Error("invalid_client"), { response: { data: { error: "invalid_client" } } })), "GOOGLE_CLIENT_CONFIG");
  assert.equal(classifySyncError(new Error("boom")), "SYNC_FAILED");
});

test("overlapping runs are prevented by the lease, and an expired lease is reclaimed", async () => {
  const db = standardTables().seed("profiles", fullProfile({ classroomSyncLease: Date.now() + 60_000 }));
  const deps = { db, env, ai: groq(), Classroom: fakeClassroom({ c1: { name: "DSA" } }), OAuth2: FakeOAuth, now: () => now };
  assert.deepEqual(await runClassroomSync(deps), { skipped: "IN_PROGRESS" });
  db.seed("profiles", fullProfile({ classroomSyncLease: Date.now() - 1 }));
  assert.equal((await runClassroomSync(deps)).status, "SUCCESS");
});

test("a run that exceeds its time budget stops cleanly and resumes next time", async () => {
  const db = standardTables().seed("profiles", fullProfile());
  const Classroom = fakeClassroom({ c1: { name: "DSA", coursework: [work("w1", "One"), work("w2", "Two", "2026-09-17T10:05:00.000Z")] } });
  const truncated = await runClassroomSync({ db, env, ai: groq(), Classroom, OAuth2: FakeOAuth, now: () => now }, { budgetMs: -1, enrich: false });
  assert.equal(truncated.status, "PARTIAL");
  assert.equal(truncated.lastResult.truncated, true);
  assert.equal(db.get("sync", { userId: "demo-user", courseId: "c1" }), undefined, "no watermark advance on a partial pass");
  const resumed = await runClassroomSync({ db, env, ai: groq(), Classroom, OAuth2: FakeOAuth, now: () => now }, { enrich: false });
  assert.equal(resumed.status, "SUCCESS");
  assert.equal(db.all("tasks").length, 2);
});

test("a failed estimate never fails the sync", async () => {
  const db = standardTables().seed("profiles", fullProfile());
  const ai = groq();
  const original = ai.generateStructured.bind(ai);
  ai.generateStructured = async (request) => { if (request.tier === "reasoning") throw new Error("Groq down"); return original(request); };
  const result = await runClassroomSync({ db, env, ai, Classroom: fakeClassroom({ c1: { name: "DSA", coursework: [work("w1", "Assignment 1")] } }), OAuth2: FakeOAuth, now: () => now });
  assert.equal(result.status, "SUCCESS");
  assert.equal(db.all("tasks")[0].aiEstimate, null);
});

test("Sync Now runs the same sync and reports every outcome safely", async () => {
  const call = async (runSync, db = standardTables()) => {
    const response = await handleClassroom({ rawPath: "/classroom/sync", requestContext: { http: { method: "POST" } } }, { db, env, runSync });
    return { status: response.statusCode, body: JSON.parse(response.body) };
  };
  let options;
  const ok = await call(async (_deps, opts) => { options = opts; return { status: "SUCCESS", lastResult: { created: 2 } }; });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.sync.status, "SUCCESS");
  assert.equal(options.trigger, "manual");
  assert.ok(options.budgetMs <= 25_000, "fits inside the API Gateway timeout");
  assert.equal(options.enrich, false);
  assert.equal((await call(async () => ({ skipped: "DISCONNECTED" }))).body.error.code, "CLASSROOM_NOT_CONNECTED");
  assert.equal((await call(async () => ({ skipped: "IN_PROGRESS" }))).body.error.code, "SYNC_IN_PROGRESS");
  const reauth = await call(async () => { throw Object.assign(new Error("x"), { syncStatus: { status: "REAUTH_REQUIRED" } }); });
  assert.equal(reauth.status, 409);
  assert.equal(reauth.body.error.code, "REAUTH_REQUIRED");
  const failed = await call(async () => { throw Object.assign(new Error("secret internals"), { syncStatus: { status: "ERROR" } }); });
  assert.equal(failed.body.error.code, "SYNC_FAILED");
  assert.ok(!JSON.stringify(failed.body).includes("secret internals"));

  // End to end through the real handler, sync, and fake Google.
  const db = standardTables().seed("profiles", fullProfile());
  const real = await call((deps, opts) => runClassroomSync({ ...deps, ai: groq(), Classroom: fakeClassroom({ c1: { name: "DSA", coursework: [work("w9", "Quiz")] } }), OAuth2: FakeOAuth, now: () => now }, opts), db);
  assert.equal(real.body.sync.status, "SUCCESS");
  assert.equal(db.all("tasks").length, 1);
});

test("a disconnected student is skipped quietly instead of failing every 15 minutes", async () => {
  const db = standardTables().seed("profiles", fullProfile({ classroomTokens: undefined }));
  delete db.data.profiles.get(JSON.stringify(["demo-user"])).classroomTokens;
  assert.deepEqual(await runClassroomSync({ db, env, ai: groq(), now: () => now }), { skipped: "DISCONNECTED" });
});
