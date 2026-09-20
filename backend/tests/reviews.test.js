import assert from "node:assert/strict";
import test from "node:test";
import { ingestNotice } from "../lib/ingestion.js";
import { decideReview } from "../lib/review-resolution.js";
import { listReviews } from "../lib/reviews.js";
import { reconcileTasks } from "../lib/tasks.js";
import { classroomSource } from "../lib/sources.js";
import { standardEnv, standardTables } from "./helpers/fake-dynamo.js";

const now = new Date("2026-09-20T03:30:00.000Z");
const env = { ...standardEnv, SOURCE_REVIEWS_TABLE: "reviews" };
const profile = { userId: "demo-user", name: "Maya", program: "CS", year: "3", section: "A", connectedCourses: ["os"], timezone: "Asia/Kolkata",
  timetableSlots: [{ id: "11111111-1111-4111-8111-111111111111", day: "Monday", startTime: "10:00", endTime: "11:00", subject: "OS Lecture", type: "Lecture", room: "" }] };
const notice = { text: "Hope you completed the assignment; it will be checked in OS class and graded.", sourceType: "classroom", sourceRef: "os:announcement:a1",
  postedAt: "2026-09-19T06:38:00.000Z", updatedAt: "2026-09-19T06:38:00.000Z", sourceUrl: "https://classroom.google.com/c/test/a1" };
const ai = { name: "test", async generateStructured() { return { results: [], ignoreReason: "informational" }; } };
const deps = (db) => ({ db, env, ai, tableName: "events", profileTableName: "profiles", now: () => now });

test("implicit class-check obligation waits for a decision and never invents a deadline", async () => {
  const db = standardTables().seed("profiles", profile);
  const outcome = await ingestNotice(notice, deps(db));
  assert.equal(outcome.action, "REVIEW");
  assert.equal(db.all("events").length, 0);
  assert.equal(db.all("tasks").length, 0);
  const [review] = await listReviews(db, "reviews");
  assert.match(review.ambiguity, /not an explicit deadline/);
  assert.equal(review.recommendedAction, "KEEP_NO_DEADLINE");
  assert.equal(review.suggestedDeadline, "2026-09-21T10:00");
  assert.ok(review.options.includes("USE_CLASS_TIME"));
  db.seed("sync", { userId: "demo-user", courseId: "os", lastSyncedAt: "1970-01-01T00:00:00.000Z", courseName: "OS",
    reviewItems: [{ sourceRef: notice.sourceRef, revision: db.all("reviews")[0].revision, updatedAt: notice.updatedAt, code: "NEEDS_REVIEW", sourceUrl: notice.sourceUrl, reviewId: review.id }], processedItems: [] });
  const decided = await decideReview(deps(db), review.id, { action: "KEEP_NO_DEADLINE" }, now);
  assert.equal(decided.outcome.action, "CREATE");
  assert.equal(db.all("events")[0].currentDeadline, null);
  assert.equal((await reconcileTasks(db, { events: "events", tasks: "tasks" }, now)).length, 1);
  assert.deepEqual(await listReviews(db, "reviews"), []);
  assert.equal(db.all("sync")[0].reviewItems.length, 0);
  const source = classroomSource({ ...profile, classroomTokens: { accessToken: "test", refreshToken: "test", expiresAt: 1_900_000_000_000 },
    classroomSync: { status: "PARTIAL", lastResult: { needsReview: 1, reviewItems: [{ sourceRef: notice.sourceRef }] } } }, db.all("sync"), now);
  assert.equal(source.sync.lastResult.needsReview, 0, "resolved reviews leave the visible source status");
  assert.equal(db.all("sync")[0].processedItems[0].revision, db.all("reviews")[0].revision);
  assert.equal((await ingestNotice(notice, deps(db))).action, "IGNORE");
  assert.equal(db.all("events").length, 1);
});

test("a similar PDF obligation enters review before it can change an existing task", async () => {
  const db = standardTables().seed("profiles", profile).seed("events", {
    userId: "demo-user", eventId: "22222222-2222-5222-8222-222222222222", title: "OS Lab assignment 3", type: "Assignment",
    currentDeadline: "2026-09-25T12:00:00.000Z", venue: null, estimatedHours: 0, status: "ACTIVE", sourceType: "classroom",
    sourceRef: "os:coursework:work3", priorityScore: 0, changeHistory: [],
  });
  const pdf = { text: "OS Lab assignment 3 has new submission instructions.", sourceType: "pdf", sourceRef: "demo-user/documents/a.pdf",
    sourceFileName: "Lab_Assignment_3.pdf", sourceDocumentId: "33333333-3333-4333-8333-333333333333" };
  const model = { name: "test", async generateStructured() { return { results: [{ action: "CREATE", targetEventId: null, changeSummary: "New PDF obligation",
    eventDetails: { title: "OS Lab assignment 3", type: "Assignment", currentDeadline: "2026-09-26T17:00", deadlineText: null,
      certainty: "confirmed", venue: null, estimatedHours: 0, actionSummary: "Submit the OS lab assignment.", instructions: ["Use the new cover sheet."],
      requirements: [], topics: [], submissionMethod: null, links: [] } }], ignoreReason: null }; } };
  const result = await ingestNotice(pdf, { ...deps(db), ai: model });
  assert.equal(result.action, "REVIEW");
  assert.equal(db.all("events").length, 1);
  const [review] = await listReviews(db, "reviews");
  assert.equal(review.sourceFileName, "Lab_Assignment_3.pdf");
  assert.equal(review.candidates[0].title, "OS Lab assignment 3");
  assert.ok(review.options.includes("UPDATE_EXISTING"));
  const resolved = await decideReview(deps(db), review.id, { action: "UPDATE_EXISTING", targetEventId: review.candidates[0].eventId }, now);
  assert.equal(resolved.outcome.action, "UPDATE");
  assert.equal(db.all("events").length, 1);
  assert.equal(db.all("events")[0].linkedSources[0].fileName, "Lab_Assignment_3.pdf");
  assert.deepEqual(await listReviews(db, "reviews"), []);
});

const details = (title, deadline) => ({ title, type: "Assignment", currentDeadline: deadline, deadlineText: null, certainty: "confirmed", venue: null,
  estimatedHours: 0, actionSummary: `Submit ${title}.`, instructions: [], requirements: [], topics: [], submissionMethod: null, links: [] });
const modelReturning = (...results) => ({ name: "test", async generateStructured() { return { results, ignoreReason: null }; } });
const activeEvent = (id, title, deadline, sourceRef) => ({ userId: "demo-user", eventId: id, title, type: "Assignment", currentDeadline: deadline, venue: null,
  estimatedHours: 0, status: "ACTIVE", sourceType: "classroom", sourceRef, priorityScore: 0, changeHistory: [] });

test("numbered series are separate obligations: Quiz 2 never asks whether it is Quiz 1", async () => {
  const db = standardTables().seed("profiles", profile).seed("events", activeEvent("22222222-2222-5222-8222-222222222222", "DSA Quiz 1", "2026-09-25T12:00:00.000Z", "os:coursework:q1"));
  const next = { text: "DSA Quiz 2 is due 30 September 2026 at 5 PM.", sourceType: "classroom", sourceRef: "os:announcement:q2",
    postedAt: "2026-09-19T06:38:00.000Z", updatedAt: "2026-09-19T06:38:00.000Z", sourceUrl: "https://classroom.google.com/c/test/q2" };
  const ai = modelReturning({ action: "CREATE", targetEventId: null, changeSummary: "New quiz", eventDetails: details("DSA Quiz 2", "2026-09-30T17:00") });
  const result = await ingestNotice(next, { ...deps(db), ai });
  assert.equal(result.action, "CREATE", "a different number is a different task, not an ambiguity");
  assert.equal(db.all("events").length, 2);
  assert.deepEqual(await listReviews(db, "reviews"), []);
});

test("an explicit deadline is automated even when the post also mentions class checking", async () => {
  const db = standardTables().seed("profiles", profile);
  const explicit = { text: "Assignment 2 is due 30 September 2026 at 5 PM. It will be checked in OS class and graded.", sourceType: "classroom", sourceRef: "os:announcement:a2",
    postedAt: "2026-09-19T06:38:00.000Z", updatedAt: "2026-09-19T06:38:00.000Z", sourceUrl: "https://classroom.google.com/c/test/a2" };
  const ai = modelReturning({ action: "CREATE", targetEventId: null, changeSummary: "New assignment", eventDetails: details("OS Assignment 2", "2026-09-30T17:00") });
  const result = await ingestNotice(explicit, { ...deps(db), ai });
  assert.equal(result.action, "CREATE", "confident items are not sent to review");
  assert.equal(db.all("events")[0].currentDeadline, "2026-09-30T11:30:00.000Z");
  assert.deepEqual(await listReviews(db, "reviews"), []);
});

test("deleted source tasks do not consume the estimate-enrichment budget", async () => {
  const { enrichUnestimatedTasks } = await import("../lib/enrichment.js");
  const { createManualTask } = await import("../lib/tasks.js");
  const db = standardTables();
  const gone = await createManualTask(db, "tasks", { title: "Deleted first", deadline: "2026-09-21T18:00" }, { now, timeZone: "Asia/Kolkata" });
  await createManualTask(db, "tasks", { title: "Live later", deadline: "2026-09-28T18:00" }, { now, timeZone: "Asia/Kolkata" });
  const row = db.all("tasks").find((task) => task.taskId === gone.taskId);
  db.seed("tasks", { ...row, deletedAt: now.toISOString() });
  const seen = [];
  const ai = { name: "test", modelFor: () => "test", async generateStructured({ prompt }) {
    seen.push(prompt); return { estimatedMinutes: 60, workUnits: [{ title: "Do it", minutes: 60 }], rationale: "test" }; } };
  const estimated = await enrichUnestimatedTasks({ db, ai }, "tasks", { limit: 1, now });
  assert.equal(estimated, 1);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /Live later/);
});
