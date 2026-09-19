import assert from "node:assert/strict";
import test from "node:test";
import { ingestNotice, noticeEventId } from "../lib/ingestion.js";
import { classroomSourceUrl } from "../lib/source-truth.js";
import { getTaskRecord, toTaskDTO, completeTask } from "../lib/tasks.js";
import { runClassroomSync } from "../lib/classroom-run.js";
import { ensurePlanFresh, plannerRange } from "../lib/planner.js";
import { standardEnv, standardTables } from "./helpers/fake-dynamo.js";

const now = new Date("2026-09-21T03:30:00.000Z");
const iso = (local) => new Date(`${local}+05:30`).toISOString();
const FORM = "https://forms.gle/test-form";
const SOURCE = "https://classroom.google.com/c/test/a/post/details";
const profile = {
  userId: "demo-user", name: "Demo", program: "CS", year: "3", section: "A", timezone: "Asia/Kolkata",
  connectedCourses: ["c1"], classroomTokens: { accessToken: "test", refreshToken: "test", expiresAt: 1900000000000 },
  timetableSlots: [{ day: "Monday", startTime: "18:00", endTime: "19:00", subject: "DSA", type: "Lecture", room: "204" }],
  planning: { dailyStudyHours: 1, preferredStudyStart: "18:00", preferredStudyEnd: "21:00", autoScheduleStudyBlocks: true, avoidClassConflicts: true },
};
const world = () => standardTables().seed("profiles", profile);
const details = (changes = {}) => ({ title: "Submit DSA architecture diagram", type: "Assignment", currentDeadline: "2026-09-22T18:00", estimatedHours: 4,
  actionSummary: "Submit the diagram using the form.", instructions: ["Open the form", "Upload the diagram"], requirements: ["Team member names", "Repository link"],
  topics: ["Architecture"], submissionMethod: "Google Form", links: [{ label: "Submission form", url: FORM }], venue: "Lab 1", ...changes });
const item = (changes = {}, action = "CREATE", targetEventId = null) => ({ action, targetEventId, eventDetails: details(changes), changeSummary: "Model prose must not become the change diff" });
const source = (changes = {}) => ({ text: `Submit the DSA architecture diagram by 22 September 2026 at 6 PM. Include team members and repository link. ${FORM}`, sourceType: "classroom", sourceRef: "c1:announcement:a1", postedAt: "2026-09-19T06:00:00.000Z", updatedAt: "2026-09-19T06:00:00.000Z", sourceUrl: SOURCE, ...changes });
const deps = (db) => ({ db, env: standardEnv, tableName: "events", profileTableName: "profiles", now: () => now, taskContext: { courseName: "DSA" } });
const ingest = (db, notice, results, inspect = () => {}) => ingestNotice(notice, { ...deps(db), ai: { async generateStructured(input) { inspect(input); return { results }; } } });
const dto = async (db, id) => toTaskDTO(await getTaskRecord(db, "tasks", id), { now, dailyStudyMinutes: 60 }, { detail: true });

test("same-source edit preserves identity, rich details, latest change and all student-owned state; replay skips AI", async () => {
  const db = world();
  const first = await ingest(db, source(), [item()]);
  const id = first.event.eventId;
  const task = await getTaskRecord(db, "tasks", id);
  const checklist = [{ id: crypto.randomUUID(), text: "Draft", done: true, createdAt: now.toISOString(), completedAt: now.toISOString() }];
  db.seed("tasks", { ...task, notes: "My notes", actualMinutes: 40, bookmarked: true, checklist });
  db.seed("focus", { userId: "demo-user", sessionId: "existing-session", taskId: id });
  const edited = source({ text: "Update: Deadline extended to 24 September 2026 at 8 PM. Use the same form. All other requirements remain unchanged.", updatedAt: now.toISOString() });
  // Even CREATE from the model must become an update of the original source.
  const next = await ingest(db, edited, [item({ currentDeadline: "2026-09-24T20:00", actionSummary: null, instructions: [], requirements: [], topics: [], links: [], venue: null, submissionMethod: null })]);
  assert.equal(next.action, "UPDATE"); assert.equal(next.event.eventId, id);
  assert.equal(noticeEventId(source()), noticeEventId(edited));
  const saved = await dto(db, id);
  assert.equal(saved.deadline, iso("2026-09-24T20:00"));
  assert.equal(saved.sourceUrl, SOURCE); assert.equal(saved.course.name, "DSA");
  assert.deepEqual(saved.details.requirements, details().requirements);
  assert.deepEqual(saved.details.instructions, details().instructions);
  assert.deepEqual(saved.details.topics, ["Architecture"]);
  assert.equal(saved.details.actionSummary, details().actionSummary);
  assert.equal(saved.details.submissionMethod, "Google Form");
  assert.equal(saved.details.links[0].url, FORM); assert.equal(saved.details.venue, "Lab 1");
  assert.deepEqual(saved.latestChange.fields, [{ field: "currentDeadline", before: iso("2026-09-22T18:00"), after: iso("2026-09-24T20:00") }]);
  assert.equal(saved.notes, "My notes"); assert.equal(saved.actualMinutes, 40); assert.equal(saved.bookmarked, true); assert.deepEqual(saved.checklist, checklist);
  assert.equal(db.all("focus").length, 1);
  let calls = 0; const replay = await ingest(db, edited, [], () => calls++);
  assert.equal(calls, 0); assert.equal(replay.reason, "alreadyProcessed");
  assert.deepEqual(await dto(db, id), saved);
  assert.equal(db.all("events").length, 1); assert.equal(db.all("tasks").length, 1);
});

test("legacy same-source event outside 14 days updates its existing ID and enters only the scoped prompt", async () => {
  const db = world();
  const first = await ingest(db, source(), [item({ currentDeadline: "2026-11-22T18:00" })]);
  const legacy = { ...first.event }; delete legacy.sourceMeta; delete legacy.sourceUrl;
  db.seed("events", legacy);
  const other = await ingest(db, source({ sourceRef: "c2:announcement:other" }), [item()]);
  const edited = source({ text: "Deadline extended to 24 November at 8 PM", updatedAt: now.toISOString() });
  const result = await ingest(db, edited, [item({ currentDeadline: "2026-11-24T20:00" }, "UPDATE", legacy.eventId)], ({ prompt }) => {
    assert.ok(prompt.includes(legacy.eventId)); assert.ok(!prompt.includes(other.event.eventId));
  });
  assert.equal(result.event.eventId, legacy.eventId); assert.equal(result.action, "UPDATE");
  assert.equal(db.all("events").length, 2);
});

for (const title of ["Quiz", "Quiz-1", "Quiz-2", "Lab", "Lab Viva", "Assignment 1", "Project Review", "Presentation"]) {
  test(`${title}: different courses and different weeks remain separate; same occurrence reminder deduplicates`, async () => {
    const db = world();
    const first = await ingest(db, source(), [item({ title })]);
    await ingest(db, source({ sourceRef: "c2:announcement:b1" }), [item({ title })]);
    await ingest(db, source({ sourceRef: "c1:announcement:a2" }), [item({ title, currentDeadline: "2026-10-13T18:00" })]);
    const reminder = await ingest(db, source({ sourceRef: "c1:announcement:reminder" }), [item({ title })]);
    assert.equal(reminder.reason, "duplicate"); assert.equal(reminder.event.eventId, first.event.eventId);
    assert.equal(db.all("events").length, 3); assert.equal(db.all("tasks").length, 3);
    const update = await ingest(db, source({ sourceRef: "c1:announcement:reminder", text: "Venue changed to Lab 3" }), [item({ title, venue: "Lab 3" })]);
    assert.equal(update.event.eventId, first.event.eventId);
  });
}

test("multi-item edits survive reordering, deadline and venue changes without task duplication", async () => {
  const db = world();
  const items = [item({ title: "Assignment 3" }), item({ title: "Quiz 2", type: "Exam" }), item({ title: "Bring lab record", type: "Lab" })];
  const first = await ingest(db, source(), items);
  const ids = Object.fromEntries(first.results.map(({ event }) => [event.title, event.eventId]));
  const changed = source({ text: "Quiz 2 moved. Bring lab record in Lab 3. Assignment 3 extended.", updatedAt: now.toISOString() });
  const next = await ingest(db, changed, [item({ title: "Bring lab record", type: "Lab", venue: "Lab 3" }), item({ title: "Assignment 3", currentDeadline: "2026-09-24T20:00" }), item({ title: "Quiz 2", type: "Exam" })]);
  for (const entry of next.results) assert.equal(entry.event.eventId, ids[entry.event.title]);
  assert.equal(db.all("tasks").length, 3); assert.equal(db.all("events").length, 3);
  await ingest(db, changed, [], () => assert.fail("replay must not call AI"));
});

test("new requirements and cancellation preserve existing task state, including completed work", async () => {
  const db = world();
  const { event } = await ingest(db, source(), [item()]);
  const added = await ingest(db, source({ text: "Bring ID card as well.", updatedAt: now.toISOString() }), [item({ requirements: ["ID card"] }, "UPDATE", event.eventId)]);
  assert.deepEqual(added.event.details.requirements, ["Team member names", "Repository link", "ID card"]);
  assert.ok(added.event.latestChange.fields.some((field) => field.field === "requirements"));
  await completeTask(db, "tasks", event.eventId, now);
  await ingest(db, source({ text: "The assignment is withdrawn.", updatedAt: "2026-09-22T03:30:00.000Z" }), [{ action: "CANCEL", targetEventId: event.eventId }]);
  const saved = await dto(db, event.eventId);
  assert.equal(saved.status, "COMPLETED"); assert.equal(saved.sourceStatus, "CANCELLED");
});

test("provenance rejects invented hosts, credentials and unsafe protocols", () => {
  for (const url of ["javascript:alert(1)", "https://classroom.google.com.evil.test/c/x", "http://classroom.google.com/c/x", "https://x@classroom.google.com/c/x", "https://classroom.google.com:444/c/x"]) assert.equal(classroomSourceUrl(url), null);
  assert.equal(classroomSourceUrl(SOURCE), SOURCE);
});

class OAuth { setCredentials() {} on() {} }
function liveShape(db, ai, posts) {
  class Classroom { constructor() { this.courses = {
    get: async () => ({ data: { name: "DSA" } }),
    announcements: { list: async () => ({ data: { announcements: posts } }) },
    courseWork: { list: async () => ({ data: {} }) },
  }; } }
  return { ...deps(db), ai, Classroom, OAuth2: OAuth, env: { ...standardEnv, GOOGLE_CLIENT_ID: "test", GOOGLE_CLIENT_SECRET: "test", GOOGLE_REDIRECT_URI: "http://localhost:3001/classroom/callback" } };
}
const post = (changes = {}) => ({ id: "a1", text: `Submit diagram ${FORM}`, creationTime: "2026-09-19T06:00:00.000Z", updateTime: "2026-09-20T06:00:00.000Z", alternateLink: SOURCE, ...changes });

test("permanent matching conflict advances checkpoint but persists review across syncs; source edit retries it", async () => {
  const db = world(); const posts = [post()]; let calls = 0;
  const ai = { async generateStructured() { calls++; return { results: [{ action: "CANCEL", targetEventId: "11111111-1111-5111-8111-111111111111" }] }; } };
  const dependencies = liveShape(db, ai, posts);
  const first = await runClassroomSync(dependencies, { enrich: false });
  assert.equal(first.status, "PARTIAL"); assert.equal(first.lastResult.needsReview, 1);
  assert.equal(first.lastSuccessfulSyncAt, null);
  assert.equal(db.all("sync")[0].lastSyncedAt, posts[0].updateTime);
  const second = await runClassroomSync(dependencies, { enrich: false });
  assert.equal(calls, 1); assert.equal(second.lastResult.needsReview, 1);
  posts[0] = post({ updateTime: now.toISOString() });
  ai.generateStructured = async () => { calls++; return { results: [item()] }; };
  const third = await runClassroomSync(dependencies, { enrich: false });
  assert.equal(third.status, "SUCCESS"); assert.equal(third.lastResult.needsReview, 0); assert.equal(calls, 2);
  assert.equal((await dto(db, db.all("tasks")[0].taskId)).sourceUrl, SOURCE);
});

for (const [code, category] of [["UNAVAILABLE", "temporaryFailed"], ["INVALID_MODEL_RESPONSE", "validationFailed"], ["EVENT_CHANGED", "raceSkipped"]]) {
  test(`${code}: source stays retryable without moving the checkpoint`, async () => {
    const db = world(); const posts = [post()]; let calls = 0;
    const ai = { async generateStructured() { calls++; throw Object.assign(new Error("private diagnostic"), { code }); } };
    const dependencies = liveShape(db, ai, posts);
    const first = await runClassroomSync(dependencies, { enrich: false });
    assert.equal(first.lastResult[category], 1); assert.equal(db.all("sync").length, 0);
    ai.generateStructured = async () => { calls++; return { results: [] }; };
    const next = await runClassroomSync(dependencies, { enrich: false });
    assert.equal(next.status, "SUCCESS"); assert.equal(calls, 2);
    assert.equal(db.all("sync")[0].lastSyncedAt, posts[0].updateTime);
  });
}

test("source deadline update reaches planner; remaining effort, classes, capacity, unknown effort and idempotence hold", async () => {
  const db = world(); const dependencies = { db, env: standardEnv, tables: { profile: "profiles", tasks: "tasks", events: "events", blocks: "blocks", syncState: "sync" } };
  const first = await ingest(db, source(), [item()]);
  const original = await getTaskRecord(db, "tasks", first.event.eventId);
  db.seed("tasks", { ...original, actualMinutes: 60 });
  await ingest(db, source({ sourceRef: "c1:announcement:unknown" }), [item({ title: "Unsized task", estimatedHours: 0 })]);
  let context = await ensurePlanFresh(dependencies, now);
  let range = await plannerRange(dependencies, { from: "2026-09-21", to: "2026-09-27" }, now, context);
  assert.equal(range.capacity.atRisk, true);
  assert.equal(range.capacity.unestimatedTasks.length, 1);
  await ingest(db, source({ text: "Extended to 24 September 8 PM", updatedAt: now.toISOString() }), [item({ currentDeadline: "2026-09-24T20:00" })]);
  context = await ensurePlanFresh(dependencies, now);
  assert.equal(context.replanned, true);
  range = await plannerRange(dependencies, { from: "2026-09-21", to: "2026-09-27" }, now, context);
  assert.equal(range.deadlines.find((entry) => entry.taskId === first.event.eventId).deadline, iso("2026-09-24T20:00"));
  const blocks = range.blocks.filter((block) => block.taskId === first.event.eventId);
  assert.equal(blocks.reduce((total, block) => total + (Date.parse(block.end) - Date.parse(block.start)) / 60000, 0), 180);
  assert.ok(!blocks.some((block) => range.classes.some((slot) => Date.parse(block.start) < Date.parse(slot.end) && Date.parse(block.end) > Date.parse(slot.start))));
  assert.equal((await ensurePlanFresh(dependencies, now)).replanned, false);
  assert.equal(new Set(db.all("blocks").map((block) => block.date)).size, db.all("blocks").length);
  await ingest(db, source({ text: "Assignment withdrawn", updatedAt: "2026-09-22T05:00:00.000Z" }), [{ action: "CANCEL", targetEventId: first.event.eventId }]);
  context = await ensurePlanFresh(dependencies, now);
  range = await plannerRange(dependencies, { from: "2026-09-21", to: "2026-09-27" }, now, context);
  assert.ok(!range.blocks.some((block) => block.taskId === first.event.eventId));
});
