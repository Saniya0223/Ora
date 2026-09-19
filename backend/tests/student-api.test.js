import assert from "node:assert/strict";
import test from "node:test";
import { handleStudent } from "../handlers/student.js";
import { handleDocuments } from "../handlers/documents.js";
import { standardEnv, standardTables } from "./helpers/fake-dynamo.js";

const TZ = "Asia/Kolkata";
const now = new Date("2026-09-21T06:30:00.000Z"); // Monday 12:00 IST
const SECRET_TOKENS = { accessToken: "ya29.SECRET-ACCESS", refreshToken: "1//SECRET-REFRESH", expiresAt: 1_900_000_000_000 };

function profile(overrides = {}) {
  return {
    userId: "demo-user", name: "Maya Lin", program: "CS", year: "3", section: "A",
    classroomTokens: SECRET_TOKENS, connectedCourses: ["c1"],
    semester: "Spring 2026", semesterStartDate: "2026-08-03", timezone: TZ,
    timetableSlots: [
      { id: "11111111-1111-4111-8111-111111111111", day: "Monday", startTime: "09:00", endTime: "10:30", subject: "DSA Lecture", type: "Lecture", room: "Hall 204" },
      { id: "22222222-2222-4222-8222-222222222222", day: "Monday", startTime: "14:00", endTime: "16:00", subject: "DSA Lab", type: "Lab", room: "Lab 3" },
    ],
    planning: { dailyStudyHours: 4, preferredStudyStart: "18:00", preferredStudyEnd: "23:00", autoScheduleStudyBlocks: true, avoidClassConflicts: true },
    ...overrides,
  };
}

function api(db, overrides = {}) {
  return async (method, path, body, queryStringParameters) => {
    const response = await handleStudent(
      { rawPath: path, requestContext: { http: { method } }, queryStringParameters, body: body === undefined ? undefined : JSON.stringify(body) },
      { db, env: { ...standardEnv, ...overrides }, now: () => now },
    );
    const parsed = response.headers["content-type"].startsWith("application/json") ? JSON.parse(response.body) : response.body;
    return { status: response.statusCode, body: parsed, raw: response.body, headers: response.headers };
  };
}

test("the dashboard aggregates counts, the next class, today's schedule, and sync health", async () => {
  const db = standardTables().seed("profiles", profile());
  const call = api(db);
  await call("POST", "/tasks", { title: "DSA Midterm Mock Exam", courseName: "CS302", type: "EXAM", deadline: "2026-09-22T09:00", estimatedMinutes: 180 });
  await call("POST", "/tasks", { title: "Cloud Architecture Proposal", courseName: "CS305", type: "ASSIGNMENT", deadline: "2026-10-05T23:59", estimatedMinutes: 120 });
  const done = await call("POST", "/tasks", { title: "Verify DSA Lab Attendance", type: "ADMIN", deadline: "2026-09-21T17:00" });
  await call("POST", `/tasks/${done.body.task.id}/complete`);

  const { status, body } = await call("GET", "/dashboard");
  assert.equal(status, 200);
  assert.equal(body.profile.name, "Maya Lin");
  assert.equal(body.profile.academicWeek, 8, "3 Aug to 21 Sep is week 8");
  assert.equal(body.date.today, "2026-09-21");
  assert.equal(body.date.weekday, "Monday");
  assert.equal(body.nextClass.title, "DSA Lab", "09:00 already ended at 12:00");
  assert.equal(body.nextClass.inProgress, false);
  assert.equal(body.summary.completedToday, 1);
  // The exam is due tomorrow (HIGH) and has study blocks today.
  const studyToday = body.todaySchedule.filter((item) => item.kind === "STUDY");
  assert.ok(studyToday.length > 0);
  assert.equal(body.summary.plannedStudyMinutes, studyToday.reduce((sum, item) => sum + (Date.parse(item.end) - Date.parse(item.start)) / 60_000, 0));
  const todayTaskIds = new Set(studyToday.map((item) => item.taskId));
  assert.equal(body.summary.tasksToday, todayTaskIds.size);
  assert.equal(body.summary.highPriority, body.priorities.filter((task) => todayTaskIds.has(task.id) && task.effectivePriority === "HIGH").length);
  assert.equal(body.priorities[0].title, "DSA Midterm Mock Exam");
  const chronological = body.todaySchedule.map((item) => item.start);
  assert.deepEqual(chronological, [...chronological].sort());
  assert.equal(body.todaySchedule.filter((item) => item.isNext).length, 1);
  assert.equal(body.sync.classroom.connection, "CONNECTED");
  assert.equal(body.sync.classroom.health, "NEVER_SYNCED", "credentials alone are never reported as synced");
});

test("no response ever contains Classroom tokens or secrets", async () => {
  const db = standardTables().seed("profiles", profile({ classroomSync: { status: "SUCCESS", trigger: "scheduled", lastAttemptAt: now.toISOString(), lastFinishedAt: now.toISOString(), lastSuccessfulSyncAt: now.toISOString(), lastErrorCode: null, lastResult: null }, classroomSyncLease: 1 }));
  const call = api(db);
  const task = await call("POST", "/tasks", { title: "Probe" });
  for (const [method, path, query] of [["GET", "/dashboard"], ["GET", "/tasks"], ["GET", `/tasks/${task.body.task.id}`], ["GET", "/preferences"], ["GET", "/sources"], ["GET", "/planner", { from: "2026-09-21", to: "2026-09-27" }]]) {
    const response = await call(method, path, undefined, query);
    assert.equal(response.status, 200, `${method} ${path}`);
    assert.ok(!response.raw.includes("SECRET"), `${method} ${path} leaked a token`);
    assert.ok(!response.raw.includes("classroomSyncLease") && !response.raw.includes("fingerprint"), `${method} ${path} leaked internals`);
  }
});

test("task routes: create, read, edit, notes, bookmark, checklist, complete, delete", async () => {
  const db = standardTables().seed("profiles", profile());
  const call = api(db);
  const created = await call("POST", "/tasks", { title: "OS Semaphore Lab Report", courseName: "CS342", type: "LAB", deadline: "2026-09-27T23:59", estimatedMinutes: 240 });
  assert.equal(created.status, 201);
  const id = created.body.task.id;
  assert.equal((await call("PATCH", `/tasks/${id}`, { estimatedMinutes: 200 })).body.task.estimatedMinutes, 200);
  assert.equal((await call("PUT", `/tasks/${id}/notes`, { notes: "Use counting semaphores" })).body.task.notes, "Use counting semaphores");
  assert.equal((await call("PUT", `/tasks/${id}/bookmark`, { bookmarked: true })).body.task.bookmarked, true);
  const item = (await call("POST", `/tasks/${id}/checklist`, { text: "Write intro" })).body.item;
  assert.equal((await call("PATCH", `/tasks/${id}/checklist/${item.id}`, { done: true })).body.task.checklistProgress.percent, 100);
  const list = await call("GET", "/tasks", undefined, { view: "upcoming", q: "semaphore" });
  assert.equal(list.body.tasks.length, 1);
  assert.equal(list.body.counts.upcoming, 1);
  assert.equal((await call("POST", `/tasks/${id}/complete`)).body.task.status, "COMPLETED");
  assert.equal((await call("POST", `/tasks/${id}/reopen`)).body.task.status, "OPEN");
  assert.equal((await call("DELETE", `/tasks/${id}`)).status, 200);
  assert.equal((await call("GET", `/tasks/${id}`)).body.error.code, "NOT_FOUND");
});

test("errors are consistent and frontend-safe", async () => {
  const db = standardTables().seed("profiles", profile());
  const call = api(db);
  const invalid = await call("POST", "/tasks", { title: "", mystery: 1 });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, "VALIDATION_ERROR");
  assert.ok(invalid.body.error.details.some((detail) => detail.field === "title"));
  assert.equal((await call("GET", "/tasks/not-a-real-id")).body.error.code, "NOT_FOUND");
  assert.equal((await call("GET", "/nowhere")).status, 404);
  assert.equal((await call("PUT", "/dashboard")).status, 405);
  assert.equal((await call("GET", "/tasks", undefined, { view: "sideways" })).body.error.code, "VALIDATION_ERROR");
  assert.equal((await call("GET", "/planner", undefined, { from: "2026-09-01", to: "2026-12-01" })).body.error.code, "VALIDATION_ERROR", "ranges are capped");
  assert.equal((await api(standardTables(), { TASKS_TABLE: "" })("GET", "/tasks")).body.error.code, "NOT_CONFIGURED");
  db.failNext = () => true;
  const outage = await call("GET", "/tasks");
  assert.equal(outage.status, 503);
  assert.equal(outage.body.error.code, "SERVICE_UNAVAILABLE");
});

test("source-backed tasks cannot be deleted or have source fields edited over HTTP", async () => {
  const db = standardTables().seed("profiles", profile()).seed("events", {
    userId: "demo-user", eventId: "33333333-3333-5333-8333-333333333333", title: "Assignment 1", type: "Assignment",
    currentDeadline: "2026-09-20T18:29:00.000Z", venue: null, estimatedHours: 0, status: "ACTIVE",
    sourceType: "classroom", sourceRef: "c1:coursework:w1", priorityScore: 0, changeHistory: [],
  });
  const call = api(db);
  const list = await call("GET", "/tasks");
  assert.equal(list.body.tasks[0].isSourceBacked, true, "existing events are backfilled into Tasks on read");
  const id = list.body.tasks[0].id;
  assert.equal((await call("DELETE", `/tasks/${id}`)).body.error.code, "SOURCE_MANAGED");
  assert.equal((await call("PATCH", `/tasks/${id}`, { deadline: "2026-10-01T10:00" })).body.error.code, "SOURCE_MANAGED");
  assert.equal((await call("PATCH", `/tasks/${id}`, { notes: "fine" })).status, 200);
});

test("planning preferences save, load, validate, and reach the scheduler", async () => {
  const db = standardTables().seed("profiles", profile());
  const call = api(db);
  assert.equal((await call("GET", "/preferences")).body.preferences.dailyStudyHours, 4);
  const saved = await call("PUT", "/preferences", { dailyStudyHours: 2, preferredStudyStart: "07:00", preferredStudyEnd: "09:00" });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.preferences, { dailyStudyHours: 2, preferredStudyStart: "07:00", preferredStudyEnd: "09:00", autoScheduleStudyBlocks: true, avoidClassConflicts: true, timezone: TZ });
  for (const bad of [{ dailyStudyHours: 13 }, { dailyStudyHours: 0.5 }, { preferredStudyStart: "22:00", preferredStudyEnd: "21:00" }, { timezone: "Nowhere/City" }, { color: "red" }]) {
    assert.equal((await call("PUT", "/preferences", bad)).body.error.code, "VALIDATION_ERROR", JSON.stringify(bad));
  }
  await call("POST", "/tasks", { title: "Essay", deadline: "2026-09-30T23:59", estimatedMinutes: 300 });
  const planner = await call("GET", "/planner", undefined, { from: "2026-09-21", to: "2026-10-04" });
  const study = planner.body.blocks.filter((block) => block.type === "STUDY");
  assert.ok(study.length > 0);
  const ist = (iso) => new Date(Date.parse(iso) + 5.5 * 3_600_000).toISOString().slice(11, 16);
  assert.ok(study.every((block) => ist(block.start) >= "07:00" && ist(block.end) <= "09:00"), "blocks follow the saved window");
  const perDay = {};
  for (const block of study) perDay[block.start.slice(0, 10)] = (perDay[block.start.slice(0, 10)] ?? 0) + (Date.parse(block.end) - Date.parse(block.start)) / 60_000;
  assert.ok(Object.values(perDay).every((total) => total <= 120), "2 h/day limit");
});

test("replan and export respond with real data", async () => {
  const db = standardTables().seed("profiles", profile());
  const call = api(db);
  await call("POST", "/tasks", { title: "Huge report", deadline: "2026-09-22T23:59", estimatedMinutes: 2000 });
  const replanned = await call("POST", "/schedule/replan");
  assert.equal(replanned.status, 200);
  assert.equal(replanned.body.capacity.atRisk, true);
  assert.ok(replanned.body.capacity.items[0].unscheduledMinutes > 0);
  const exported = await call("GET", "/planner/export", undefined, { from: "2026-09-21", to: "2026-09-27" });
  assert.equal(exported.status, 200);
  assert.match(exported.headers["content-type"], /^text\/calendar/);
  assert.match(exported.headers["content-disposition"], /campusflow-2026-09-21-to-2026-09-27\.ics/);
  assert.match(exported.raw, /BEGIN:VEVENT/);
});

test("timetable slots get stable IDs, record their source, and can be edited or deleted one at a time", async () => {
  const legacySlot = { day: "Tuesday", startTime: "10:30", endTime: "12:30", subject: "OS Lecture", type: "Lecture", room: "" };
  const db = standardTables().seed("profiles", profile({ timetableSlots: [legacySlot] }));
  const env = { ...standardEnv, UPLOAD_BUCKET: "bucket" };
  const doc = async (method, path, body) => {
    const response = await handleDocuments({ rawPath: path, requestContext: { http: { method } }, body: body === undefined ? undefined : JSON.stringify(body) }, { db, env });
    return { status: response.statusCode, body: JSON.parse(response.body) };
  };
  const first = await doc("GET", "/timetable");
  const id = first.body.slots[0].id;
  assert.match(id, /^[0-9a-f-]{36}$/, "legacy slots gain an ID");
  assert.equal((await doc("GET", "/timetable")).body.slots[0].id, id, "and keep it");

  const imported = await doc("PUT", "/timetable", { slots: [{ ...legacySlot, subject: "OS" }], source: { fileName: "Fall2025_Schedule.pdf" } });
  assert.equal(imported.body.source.kind, "PDF");
  assert.equal(imported.body.source.fileName, "Fall2025_Schedule.pdf");
  const slotId = imported.body.slots[0].id;
  const edited = await doc("PUT", `/timetable/slots/${slotId}`, { ...legacySlot, room: "Lab 2" });
  assert.equal(edited.body.slot.room, "Lab 2");
  assert.equal(edited.body.slot.id, slotId);
  assert.equal(edited.body.source.fileName, "Fall2025_Schedule.pdf", "an edit keeps the import provenance");
  assert.equal((await doc("PUT", `/timetable/slots/${slotId}`, { ...legacySlot, startTime: "13:00", endTime: "12:00" })).status, 400);
  assert.equal((await doc("DELETE", `/timetable/slots/${slotId}`)).body.slots.length, 0);
  assert.equal((await doc("DELETE", `/timetable/slots/${slotId}`)).status, 404);

  const sources = await api(db)("GET", "/sources");
  assert.equal(sources.body.timetable.status, "NOT_IMPORTED");
  assert.equal(sources.body.timetable.source.fileName, "Fall2025_Schedule.pdf");
});

test("attachments upload through signed POSTs, confirm against S3, and download through signed links", async () => {
  const { requestAttachmentUpload, confirmAttachment, attachmentDownload, deleteAttachment } = await import("../lib/attachments.js");
  const db = standardTables().seed("profiles", profile());
  const task = (await api(db)("POST", "/tasks", { title: "With files" })).body.task;
  const objects = new Map();
  const s3 = { async send(command) {
    const name = command.constructor.name;
    if (name === "HeadObjectCommand") { const object = objects.get(command.input.Key); if (!object) throw Object.assign(new Error(), { name: "NotFound" }); return object; }
    if (name === "DeleteObjectCommand") { objects.delete(command.input.Key); return {}; }
    throw new Error(name);
  } };
  const deps = { db, s3, bucket: "bucket", tables: { tasks: "tasks" } };
  const sign = async (_client, params) => ({ url: "https://upload.example.test", fields: { key: params.Key, "Content-Type": params.Fields["Content-Type"] } });
  await assert.rejects(() => requestAttachmentUpload(deps, task.id, { fileName: "x.exe", contentType: "application/x-msdownload", size: 10 }, now, sign), (error) => error.code === "VALIDATION_ERROR");
  await assert.rejects(() => requestAttachmentUpload(deps, task.id, { fileName: "big.pdf", contentType: "application/pdf", size: 11 * 1024 * 1024 }, now, sign), (error) => error.code === "VALIDATION_ERROR");
  const requested = await requestAttachmentUpload(deps, task.id, { fileName: "notes.pdf", contentType: "application/pdf", size: 1234 }, now, sign);
  assert.equal(requested.attachment.status, "PENDING");
  assert.equal(requested.attachment.s3Key, undefined, "storage keys are never returned");
  assert.match(requested.upload.fields.key, new RegExp(`^demo-user/attachments/${task.id}/`));
  await assert.rejects(() => confirmAttachment(deps, task.id, requested.attachment.id, now), (error) => error.code === "UPLOAD_NOT_FOUND");
  objects.set(requested.upload.fields.key, { ContentLength: 1234, ContentType: "application/pdf" });
  assert.equal((await confirmAttachment(deps, task.id, requested.attachment.id, now)).status, "READY");
  const link = await attachmentDownload(deps, task.id, requested.attachment.id, async (_client, command, options) => `https://signed.example.test/${command.input.Key}?ttl=${options.expiresIn}`);
  assert.match(link.url, /ttl=300/);
  await deleteAttachment(deps, task.id, requested.attachment.id, now);
  assert.equal(objects.size, 0);
  assert.equal((await api(db)("GET", `/tasks/${task.id}/attachments`)).body.attachments.length, 0);
});

test("focus routes credit the task and report the active session", async () => {
  const db = standardTables().seed("profiles", profile());
  const call = api(db);
  const task = (await call("POST", "/tasks", { title: "Focus me", estimatedMinutes: 100 })).body.task;
  const session = (await call("POST", `/tasks/${task.id}/focus-sessions`, {})).body.session;
  assert.equal((await call("GET", "/focus-sessions/active")).body.session.id, session.id);
  const clash = await call("POST", `/tasks/${task.id}/focus-sessions`, {});
  assert.equal(clash.body.error.code, "FOCUS_SESSION_ACTIVE");
  const completed = await call("POST", `/focus-sessions/${session.id}/complete`, { completedMinutes: 0 });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.task.actualMinutes, 0);
  assert.equal((await call("GET", `/tasks/${task.id}/focus-sessions`)).body.sessions.length, 1);
});
