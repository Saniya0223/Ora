import assert from "node:assert/strict";
import test from "node:test";
import { ingestNotice } from "../lib/ingestion.js";
import { calculatePriority } from "../lib/priority.js";
import {
  addChecklistItem, applyEventToTask, completeTask, createManualTask, deleteChecklistItem, filterTasks, getTaskRecord,
  mutateTask, reconcileTasks, reopenTask, reorderChecklist, toTaskDTO, updateChecklistItem, updateTask,
} from "../lib/tasks.js";
import { standardEnv, standardTables } from "./helpers/fake-dynamo.js";

const now = new Date("2026-09-18T04:30:00.000Z"); // 10:00 IST
const ctx = { now, dailyStudyMinutes: 240 };
const tables = { tasks: "tasks", events: "events", syncState: "sync", profile: "profiles" };
const profile = { userId: "demo-user", name: "S", program: "CS", year: "3", section: "A", connectedCourses: ["c1"], timetableSlots: [] };

const eventRow = (overrides = {}) => ({
  userId: "demo-user", eventId: "11111111-1111-5111-8111-111111111111", title: "Assignment 2", type: "Assignment",
  currentDeadline: "2026-09-21T18:29:00.000Z", venue: null, estimatedHours: 0, status: "ACTIVE",
  sourceType: "classroom", sourceRef: "c1:coursework:w2", priorityScore: 0, changeHistory: ["created"], ...overrides,
});

// A scripted Groq stand-in: returns queued truth resolutions in order.
function scriptedAI(...answers) {
  return { name: "groq", async generateStructured() { return answers.shift(); } };
}

test("manual tasks are created, edited, completed, reopened, and bookmarked", async () => {
  const db = standardTables();
  const task = await createManualTask(db, "tasks", { title: "Read chapter 4", courseName: "DBMS", type: "ASSIGNMENT", deadline: "2026-09-20T18:00", estimatedMinutes: 120, checklist: ["Skim", "Notes"] }, { now, timeZone: "Asia/Kolkata" });
  assert.equal(task.deadline, "2026-09-20T12:30:00.000Z", "local deadline is read in the student's zone");
  assert.equal(task.checklist.length, 2);
  assert.equal(task.source, "MANUAL");

  const edited = await updateTask(db, "tasks", task.taskId, { title: "Read chapter 5", estimatedMinutes: 90, manualPriorityOverride: "HIGH" }, { now, timeZone: "Asia/Kolkata" });
  assert.equal(edited.title, "Read chapter 5");
  assert.equal(toTaskDTO(edited, ctx).effectivePriority, "HIGH");

  const done = await completeTask(db, "tasks", task.taskId, now);
  assert.equal(done.status, "COMPLETED");
  assert.equal((await completeTask(db, "tasks", task.taskId, now)).version, done.version, "completing twice is idempotent");
  const reopened = await reopenTask(db, "tasks", task.taskId, now);
  assert.equal(reopened.status, "OPEN");
  assert.equal(reopened.completedAt, null);

  const marked = await mutateTask(db, "tasks", task.taskId, now, (current) => Object.assign(current, { bookmarked: true }));
  assert.equal((await getTaskRecord(db, "tasks", marked.taskId)).bookmarked, true);
});

test("unknown effort is null, never zero, and time progress stays separate from checklist progress", async () => {
  const db = standardTables();
  const unknown = await createManualTask(db, "tasks", { title: "Unsized" }, { now, timeZone: "Asia/Kolkata" });
  const dto = toTaskDTO(unknown, ctx);
  assert.equal(dto.estimatedMinutes, null);
  assert.equal(dto.remainingMinutes, null);
  assert.equal(dto.progress.timePercent, null, "no estimate means progress is unknown, not 0%");

  const sized = await createManualTask(db, "tasks", { title: "Sized", estimatedMinutes: 180, checklist: ["a", "b", "c", "d"] }, { now, timeZone: "Asia/Kolkata" });
  const worked = await mutateTask(db, "tasks", sized.taskId, now, (task) => Object.assign(task, { actualMinutes: 60 }));
  const first = worked.checklist[0].id;
  const ticked = await updateChecklistItem(db, "tasks", sized.taskId, first, { done: true }, now);
  const view = toTaskDTO(ticked, ctx);
  assert.equal(view.progress.timePercent, 33, "60 of 180 minutes");
  assert.equal(view.checklistProgress.percent, 25, "1 of 4 items, reported separately");
  assert.equal(view.remainingMinutes, 120);
});

test("the checklist persists add, edit, toggle, reorder, and delete with stable IDs", async () => {
  const db = standardTables();
  const task = await createManualTask(db, "tasks", { title: "Lab" }, { now, timeZone: "Asia/Kolkata" });
  const { item: a } = await addChecklistItem(db, "tasks", task.taskId, { text: "Review binary search trees" }, now);
  const { item: b } = await addChecklistItem(db, "tasks", task.taskId, { text: "AVL rotations" }, now);
  await updateChecklistItem(db, "tasks", task.taskId, b.id, { text: "AVL rotations practice", done: true }, now);
  await reorderChecklist(db, "tasks", task.taskId, { itemIds: [b.id, a.id] }, now);
  let stored = await getTaskRecord(db, "tasks", task.taskId);
  assert.deepEqual(stored.checklist.map((item) => item.id), [b.id, a.id]);
  assert.equal(stored.checklist[0].text, "AVL rotations practice");
  assert.equal(stored.checklist[0].done, true);
  assert.ok(stored.checklist[0].completedAt);
  await assert.rejects(() => reorderChecklist(db, "tasks", task.taskId, { itemIds: [a.id] }, now), (error) => error.code === "VALIDATION_ERROR");
  await deleteChecklistItem(db, "tasks", task.taskId, a.id, now);
  stored = await getTaskRecord(db, "tasks", task.taskId);
  assert.deepEqual(stored.checklist.map((item) => item.id), [b.id]);
  await assert.rejects(() => deleteChecklistItem(db, "tasks", task.taskId, a.id, now), (error) => error.code === "NOT_FOUND");
});

test("source-backed tasks refuse edits to source-owned fields but keep student-owned ones", async () => {
  const db = standardTables().seed("events", eventRow());
  const { task } = await applyEventToTask(db, "tasks", eventRow(), { courseName: "DSA", now });
  await assert.rejects(
    () => updateTask(db, "tasks", task.taskId, { title: "Renamed", deadline: null }, { now, timeZone: "Asia/Kolkata" }),
    (error) => error.code === "SOURCE_MANAGED" && error.details.map((detail) => detail.field).join() === "title,deadline",
  );
  const edited = await updateTask(db, "tasks", task.taskId, { notes: "submit as pdf", estimatedMinutes: 150, bookmarked: true }, { now, timeZone: "Asia/Kolkata" });
  assert.equal(edited.notes, "submit as pdf");
  assert.equal(edited.studentEstimatedMinutes, 150);
  assert.equal(edited.title, "Assignment 2", "the source title is untouched");
  assert.equal(db.get("events", { userId: "demo-user", eventId: task.taskId }).title, "Assignment 2", "the AcademicEvent is never modified");
});

test("AcademicEvent CREATE, UPDATE, and CANCEL flow into the same Task without duplicates", async () => {
  const db = standardTables().seed("profiles", profile);
  const env = standardEnv;
  const base = { db, env, tableName: "events", profileTableName: "profiles", now: () => now, taskContext: { courseName: "DSA" } };
  const create = { action: "CREATE", targetEventId: null, changeSummary: "New", eventDetails: { title: "DSA Quiz", type: "Exam", currentDeadline: "2026-09-19T10:00", venue: "", estimatedHours: 2 } };

  const created = await ingestNotice({ text: "[Classroom] DSA: Announcement 'Quiz on 19 Sept'.", sourceType: "classroom", sourceRef: "c1:announcement:a1" }, { ...base, ai: scriptedAI(create) });
  assert.equal(created.action, "CREATE");
  assert.equal(created.taskId, created.event.eventId, "the Task is keyed by its event");
  let tasks = db.all("tasks");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].course.name, "DSA");
  assert.equal(tasks[0].sourceEstimatedMinutes, 120);

  // A student edit between syncs must survive the source update.
  await updateTask(db, "tasks", created.taskId, { notes: "chapters 3-5" }, { now, timeZone: "Asia/Kolkata" });

  const moved = { action: "UPDATE", targetEventId: created.event.eventId, changeSummary: "Moved", eventDetails: { title: "DSA Quiz", type: "Exam", currentDeadline: "2026-09-20T10:00", venue: "", estimatedHours: 2 } };
  await ingestNotice({ text: "[Classroom] DSA: Announcement 'Quiz moved to 20 Sept'.", sourceType: "classroom", sourceRef: "c1:announcement:a2" }, { ...base, ai: scriptedAI(moved) });
  tasks = db.all("tasks");
  assert.equal(tasks.length, 1, "UPDATE changes the same Task");
  assert.equal(tasks[0].deadline, "2026-09-20T04:30:00.000Z");
  assert.equal(tasks[0].notes, "chapters 3-5", "student notes survive a source update");

  // Replaying the original notice is a no-op: no new event, no new Task.
  await ingestNotice({ text: "[Classroom] DSA: Announcement 'Quiz on 19 Sept'.", sourceType: "classroom", sourceRef: "c1:announcement:a1" }, { ...base, ai: scriptedAI() });
  assert.equal(db.all("events").length, 1);
  assert.equal(db.all("tasks").length, 1);

  const cancel = { action: "CANCEL", targetEventId: created.event.eventId, changeSummary: "Cancelled", eventDetails: moved.eventDetails };
  await ingestNotice({ text: "[Classroom] DSA: Announcement 'Quiz cancelled'.", sourceType: "classroom", sourceRef: "c1:announcement:a3" }, { ...base, ai: scriptedAI(cancel) });
  tasks = db.all("tasks");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, "CANCELLED");
  assert.equal(tasks[0].sourceStatus, "CANCELLED");
});

test("a Task-layer failure never fails ingestion, and reconciliation repairs the gap", async () => {
  const db = standardTables().seed("profiles", profile);
  db.failNext = (name, input) => input.TableName === "tasks";
  const create = { action: "CREATE", targetEventId: null, changeSummary: "New", eventDetails: { title: "OS Lab", type: "Lab", currentDeadline: "2026-09-22T17:00", venue: "", estimatedHours: 0 } };
  const result = await ingestNotice({ text: "OS lab due 22 Sept 5pm", sourceType: "manual", sourceRef: null }, { db, env: standardEnv, tableName: "events", profileTableName: "profiles", now: () => now, ai: scriptedAI(create) });
  assert.equal(result.action, "CREATE", "the AcademicEvent was still committed");
  assert.equal(db.all("tasks").length, 0);

  db.failNext = undefined;
  const tasks = await reconcileTasks(db, tables, now);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].taskId, result.event.eventId);
  assert.equal(tasks[0].source, "MANUAL_NOTICE");
  assert.equal(tasks[0].sourceEstimatedMinutes, null, "0 hours from the model means unknown");
  assert.equal((await reconcileTasks(db, tables, now)).length, 1, "reconciling again is a no-op");
});

test("reconciliation backfills existing events, keeps course names, and a completed task stays completed on cancel", async () => {
  const db = standardTables()
    .seed("events", eventRow(), eventRow({ eventId: "22222222-2222-5222-8222-222222222222", title: "Quiz 2", type: "Exam", sourceRef: "c1:announcement:q2" }))
    .seed("sync", { userId: "demo-user", courseId: "c1", lastSyncedAt: "2026-09-18T00:00:00.000Z", courseName: "DSA" });
  const tasks = await reconcileTasks(db, tables, now);
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((task) => task.course.name === "DSA"));

  await completeTask(db, "tasks", "22222222-2222-5222-8222-222222222222", now);
  db.seed("events", eventRow({ eventId: "22222222-2222-5222-8222-222222222222", title: "Quiz 2", type: "Exam", sourceRef: "c1:announcement:q2", status: "CANCELLED" }));
  await reconcileTasks(db, tables, now);
  const quiz = await getTaskRecord(db, "tasks", "22222222-2222-5222-8222-222222222222");
  assert.equal(quiz.status, "COMPLETED", "the student's completion is not overwritten");
  assert.equal(quiz.sourceStatus, "CANCELLED", "but the cancellation is recorded");
});

test("a task the source cancelled can be neither completed nor reopened", async () => {
  const db = standardTables().seed("events", eventRow({ status: "CANCELLED" }));
  await reconcileTasks(db, tables, now);
  await assert.rejects(() => completeTask(db, "tasks", eventRow().eventId, now), (error) => error.code === "CONFLICT");
  await assert.rejects(() => reopenTask(db, "tasks", eventRow().eventId, now), (error) => error.code === "CONFLICT");
});

test("filters, search, views, and counts are computed server-side", async () => {
  const db = standardTables();
  const make = (body) => createManualTask(db, "tasks", body, { now, timeZone: "Asia/Kolkata" });
  const a = await make({ title: "Data Structures Midterm Mock", courseName: "CS302", type: "EXAM", deadline: "2026-09-19T09:00", estimatedMinutes: 180 });
  await make({ title: "Cloud Architecture Proposal", courseName: "CS305", type: "ASSIGNMENT", deadline: "2026-09-30T23:59", estimatedMinutes: 120 });
  const c = await make({ title: "Sign integrity form", type: "ADMIN", deadline: "2026-09-25T12:00" });
  await make({ title: "No deadline reading", courseName: "CS302" });
  await completeTask(db, "tasks", c.taskId, now);
  const dtos = (await reconcileTasks(db, tables, now)).map((task) => toTaskDTO(task, ctx));
  const run = (filters) => filterTasks(dtos, { view: "all", sort: "priority", ...filters }, now, "Asia/Kolkata");

  const all = run({});
  assert.deepEqual(all.counts, { all: 4, upcoming: 2, highPriority: 1, completed: 1, cancelled: 0 });
  assert.equal(all.tasks[0].id, a.taskId, "the urgent exam sorts first");
  assert.equal(all.tasks.at(-1).status, "COMPLETED");
  assert.deepEqual(run({ view: "high_priority" }).tasks.map((task) => task.title), ["Data Structures Midterm Mock"]);
  assert.deepEqual(run({ view: "completed" }).tasks.map((task) => task.title), ["Sign integrity form"]);
  assert.equal(run({ q: "midterm" }).tasks.length, 1);
  assert.equal(run({ q: "cs302" }).tasks.length, 2, "search also matches the course");
  assert.equal(run({ course: "CS305" }).tasks.length, 1);
  assert.equal(run({ type: "EXAM" }).counts.all, 1, "filters apply to counts too");
  assert.equal(run({ from: "2026-09-19", to: "2026-09-26" }).tasks.length, 2);
});

test("priority is deterministic, explained, and never needs a model", () => {
  const at = (hours) => new Date(now.getTime() + hours * 3_600_000).toISOString();
  assert.deepEqual(calculatePriority({ deadline: at(-1), type: "ASSIGNMENT", remainingMinutes: 30 }, now, 240), { level: "HIGH", reason: "OVERDUE" });
  assert.deepEqual(calculatePriority({ deadline: at(30), type: "ASSIGNMENT", remainingMinutes: null }, now, 240), { level: "HIGH", reason: "DUE_WITHIN_48_HOURS" });
  assert.deepEqual(calculatePriority({ deadline: at(80), type: "EXAM", remainingMinutes: null }, now, 240), { level: "HIGH", reason: "EXAM_WITHIN_4_DAYS" });
  assert.deepEqual(calculatePriority({ deadline: at(120), type: "ASSIGNMENT", remainingMinutes: 600 }, now, 240), { level: "HIGH", reason: "HIGH_WORKLOAD_PRESSURE" });
  assert.deepEqual(calculatePriority({ deadline: at(120), type: "ASSIGNMENT", remainingMinutes: 300 }, now, 240), { level: "MEDIUM", reason: "MODERATE_WORKLOAD_PRESSURE" });
  assert.deepEqual(calculatePriority({ deadline: at(150), type: "ASSIGNMENT", remainingMinutes: 30 }, now, 240), { level: "MEDIUM", reason: "DUE_WITHIN_7_DAYS" });
  assert.deepEqual(calculatePriority({ deadline: at(400), type: "ASSIGNMENT", remainingMinutes: 30 }, now, 240), { level: "LOW", reason: "DUE_LATER" });
  assert.deepEqual(calculatePriority({ deadline: null, type: "OTHER", remainingMinutes: null }, now, 240), { level: "LOW", reason: "NO_DEADLINE" });
});
