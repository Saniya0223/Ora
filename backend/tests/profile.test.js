import assert from "node:assert/strict";
import test from "node:test";
import { handleProfile } from "../handlers/profile.js";
import { FakeDynamo } from "./helpers/fake-dynamo.js";

const env = { STUDENT_PROFILE_TABLE: "profiles" };
const request = (method, body) => ({ requestContext: { http: { method } }, body: body === undefined ? undefined : JSON.stringify(body) });
const existing = () => ({
  userId: "demo-user", name: "Existing", program: "CS", year: "2", section: "A",
  classroomTokens: { accessToken: "access", refreshToken: "refresh", expiresAt: 1_800_000_000_000 },
  connectedCourses: ["course-1"], timetableSlots: [],
});

test("profile setup preserves private Classroom credentials and never returns them", async () => {
  const db = new FakeDynamo({ profiles: ["userId"] }).seed("profiles", existing());
  const saved = await handleProfile(request("PUT", { name: "Saniya", program: "BCA", year: "3", section: "B" }), { db, env });
  assert.equal(saved.statusCode, 200);
  const item = db.get("profiles", { userId: "demo-user" });
  assert.equal(item.classroomTokens.refreshToken, "refresh");
  assert.deepEqual(item.connectedCourses, ["course-1"]);
  assert.equal(item.name, "Saniya");
  assert.equal(JSON.parse(saved.body).profile.classroomTokens, undefined);
  const loaded = await handleProfile(request("GET"), { db, env });
  assert.equal(JSON.parse(loaded.body).profile.classroomTokens, undefined);
});

test("profile setup rejects incomplete values before writing", async () => {
  const db = new FakeDynamo({ profiles: ["userId"] });
  const response = await handleProfile(request("PUT", { name: "", program: "BCA", year: "3", section: "B" }), { db, env });
  assert.equal(response.statusCode, 400);
  assert.equal(db.log.filter((entry) => entry.name !== "GetCommand").length, 0);
});

test("a profile save never overwrites sync status or planner state written by others", async () => {
  const db = new FakeDynamo({ profiles: ["userId"] }).seed("profiles", {
    ...existing(),
    classroomSync: { status: "SUCCESS", trigger: "scheduled", lastAttemptAt: "2026-09-18T10:00:00.000Z", lastFinishedAt: "2026-09-18T10:00:05.000Z", lastSuccessfulSyncAt: "2026-09-18T10:00:05.000Z", lastErrorCode: null, lastResult: null },
    planningState: { fingerprint: "abc" },
  });
  await handleProfile(request("PUT", { name: "Saniya", program: "BCA", year: "3", section: "B" }), { db, env });
  const item = db.get("profiles", { userId: "demo-user" });
  assert.equal(item.classroomSync.status, "SUCCESS");
  assert.equal(item.planningState.fingerprint, "abc");
});

test("semester fields are optional, validated, and drive the academic week", async () => {
  const db = new FakeDynamo({ profiles: ["userId"] });
  const created = await handleProfile(request("PUT", { name: "S", program: "BCA", year: "3", section: "B" }), { db, env });
  assert.equal(created.statusCode, 200);
  assert.deepEqual(db.get("profiles", { userId: "demo-user" }).connectedCourses, []);

  const start = new Date(Date.now() - 15 * 86_400_000).toISOString().slice(0, 10);
  const saved = JSON.parse((await handleProfile(request("PUT", { name: "S", program: "BCA", year: "3", section: "B", semester: "Spring 2026", semesterStartDate: start, timezone: "Asia/Kolkata" }), { db, env })).body).profile;
  assert.equal(saved.semester, "Spring 2026");
  assert.equal(saved.timezone, "Asia/Kolkata");
  assert.equal(saved.academicWeek, 3);

  const badZone = await handleProfile(request("PUT", { name: "S", program: "BCA", year: "3", section: "B", timezone: "Mars/Olympus" }), { db, env });
  assert.equal(badZone.statusCode, 400);
  const cleared = JSON.parse((await handleProfile(request("PUT", { name: "S", program: "BCA", year: "3", section: "B", semester: null }), { db, env })).body).profile;
  assert.equal(cleared.semester, null);
});
