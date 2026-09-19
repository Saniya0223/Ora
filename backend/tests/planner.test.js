import assert from "node:assert/strict";
import test from "node:test";
import { classOccurrences, createManualBlock, deleteManualBlock, ensurePlanFresh, loadBlocks, planStudyBlocks, plannerRange, removeFutureTaskBlocks, replan, toICS } from "../lib/planner.js";
import { completeTask, createManualTask } from "../lib/tasks.js";
import { standardEnv, standardTables } from "./helpers/fake-dynamo.js";

const TZ = "Asia/Kolkata";
const now = new Date("2026-09-21T03:30:00.000Z"); // Monday 09:00 IST
const prefs = { dailyStudyHours: 4, preferredStudyStart: "18:00", preferredStudyEnd: "23:00", autoScheduleStudyBlocks: true, avoidClassConflicts: true };
const slot = (day, startTime, endTime, subject = "DSA", type = "Lecture") => ({ id: crypto.randomUUID(), day, startTime, endTime, subject, type, room: "H204" });
const task = (id, title, deadline, remainingMinutes, effectivePriority = "MEDIUM") => ({ taskId: id, title, deadline, remainingMinutes, effectivePriority, createdAt: "2026-09-20T00:00:00.000Z" });
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const minutes = (block) => (Date.parse(block.end) - Date.parse(block.start)) / 60_000;
const istDay = (iso) => new Date(Date.parse(iso) + 5.5 * 3_600_000).toISOString().slice(0, 10);
const istTime = (iso) => new Date(Date.parse(iso) + 5.5 * 3_600_000).toISOString().slice(11, 16);
const overlaps = (a, b) => Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);
const plan = (overrides = {}) => planStudyBlocks({ tasks: [], classes: [], keptBlocks: [], preferences: prefs, timeZone: TZ, now, ...overrides });

test("study blocks avoid classes, never overlap, and stay inside the preferred window", () => {
  const classes = classOccurrences([slot("Monday", "19:00", "20:00"), slot("Tuesday", "18:00", "21:00")], "2026-09-21", "2026-10-04", TZ);
  const result = plan({ classes, tasks: [task(A, "DBMS", "2026-09-25T18:29:00.000Z", 480, "HIGH"), task(B, "OS", "2026-09-26T18:29:00.000Z", 240)] });
  assert.ok(result.blocks.length > 0);
  assert.ok(!result.blocks.some((block) => classes.some((occurrence) => overlaps(block, occurrence))), "no class conflicts");
  assert.ok(!result.blocks.some((a, i) => result.blocks.some((b, j) => i < j && overlaps(a, b))), "no overlapping blocks");
  assert.ok(result.blocks.every((block) => istTime(block.start) >= "18:00" && istTime(block.end) <= "23:00" && !block.outsidePreferredWindow));
  assert.equal(result.capacity.atRisk, false);
});

test("avoidClassConflicts decides whether study may share class time", () => {
  // The whole preferred evening is a class, and the work is due tonight.
  const classes = classOccurrences([slot("Monday", "18:00", "23:00")], "2026-09-21", "2026-09-21", TZ);
  const tasks = [task(A, "DBMS", "2026-09-21T18:29:00.000Z", 60, "HIGH")];
  const avoiding = plan({ classes, tasks });
  assert.equal(avoiding.blocks.length, 1);
  assert.ok(!overlaps(avoiding.blocks[0], classes[0]), "moved clear of the class");
  assert.ok(avoiding.blocks[0].outsidePreferredWindow, "into the wider day window");
  const ignoring = plan({ classes, tasks, preferences: { ...prefs, avoidClassConflicts: false } });
  assert.ok(overlaps(ignoring.blocks[0], classes[0]), "with the setting off, the evening is used");
  assert.ok(!ignoring.blocks[0].outsidePreferredWindow);
});

test("the daily study limit holds across all tasks, and work splits across days", () => {
  const result = plan({ tasks: [task(A, "Big project", "2026-10-02T18:29:00.000Z", 600, "HIGH"), task(B, "Essay", "2026-10-02T18:29:00.000Z", 300)] });
  const perDay = {};
  for (const block of result.blocks) perDay[istDay(block.start)] = (perDay[istDay(block.start)] ?? 0) + minutes(block);
  assert.ok(Object.values(perDay).every((total) => total <= 240), JSON.stringify(perDay));
  assert.ok(Object.keys(perDay).length >= 4, "900 minutes at 4 h/day needs at least four days");
  assert.equal(result.blocks.filter((block) => block.taskId === A).reduce((sum, block) => sum + minutes(block), 0), 600);
});

test("only remaining effort is scheduled, and unknown effort is reported, not guessed", () => {
  const result = plan({ tasks: [task(A, "Half done", "2026-09-28T18:29:00.000Z", 90), task(B, "Unsized", "2026-09-28T18:29:00.000Z", null)] });
  assert.equal(result.blocks.reduce((sum, block) => sum + minutes(block), 0), 90);
  assert.deepEqual(result.capacity.unestimatedTasks.map((item) => item.taskId), [B]);
});

test("work that cannot fit is reported explicitly instead of pretending", () => {
  const result = plan({ tasks: [task(A, "DBMS Assignment", "2026-09-23T18:29:00.000Z", 900, "HIGH")] });
  assert.equal(result.capacity.atRisk, true);
  const [risk] = result.capacity.items;
  assert.equal(risk.reason, "INSUFFICIENT_CAPACITY");
  assert.equal(risk.scheduledMinutes + risk.unscheduledMinutes, 900);
  assert.ok(result.blocks.every((block) => Date.parse(block.end) <= Date.parse("2026-09-23T18:29:00.000Z")), "nothing lands after the deadline");
  assert.match(risk.message, /cannot fit before/);
  const overdue = plan({ tasks: [task(A, "Late", "2026-09-20T18:29:00.000Z", 60, "HIGH")] });
  assert.equal(overdue.capacity.items[0].reason, "DEADLINE_PASSED");
  assert.equal(overdue.blocks.length, 0);
});

test("deadline pressure overrides spreading, and the wider window is used only when needed", () => {
  // 7 h due tonight: one 5 h evening cannot hold it, so the rest moves earlier.
  const tight = plan({ tasks: [task(A, "Due tonight", "2026-09-21T18:29:00.000Z", 420, "HIGH")], preferences: { ...prefs, dailyStudyHours: 8 } });
  assert.equal(tight.capacity.atRisk, false, "fits once the wider day window is used");
  assert.equal(tight.blocks.reduce((sum, block) => sum + minutes(block), 0), 420);
  assert.ok(tight.blocks.some((block) => block.outsidePreferredWindow), "some work moved outside the evening window");
  assert.ok(tight.blocks.some((block) => !block.outsidePreferredWindow), "the evening is still used first");
  const relaxed = plan({ tasks: [task(A, "Due later", "2026-10-02T18:29:00.000Z", 240)] });
  assert.ok(relaxed.blocks.every((block) => !block.outsidePreferredWindow));
});

test("urgent work is placed first", () => {
  const result = plan({ tasks: [task(B, "Later, low", "2026-10-01T18:29:00.000Z", 240, "LOW"), task(A, "Soon, high", "2026-09-23T18:29:00.000Z", 240, "HIGH")] });
  assert.equal(result.blocks[0].taskId, A);
});

test("identical inputs produce identical blocks and block IDs", () => {
  const input = { classes: classOccurrences([slot("Wednesday", "18:30", "19:30")], "2026-09-21", "2026-10-04", TZ), tasks: [task(A, "X", "2026-09-27T18:29:00.000Z", 500, "HIGH"), task(B, "Y", "2026-09-29T18:29:00.000Z", 200)] };
  assert.deepEqual(plan(input), plan(input));
});

// ---- persisted replanning ---------------------------------------------------

const profileRow = (overrides = {}) => ({ userId: "demo-user", name: "Maya", program: "CS", year: "3", section: "A", connectedCourses: [], timetableSlots: [slot("Monday", "19:00", "20:00")], planning: prefs, ...overrides });
const deps = (db) => ({ db, env: standardEnv, tables: { profile: "profiles", tasks: "tasks", events: "events", blocks: "blocks", syncState: "sync" } });

async function world(profile = profileRow()) {
  const db = standardTables().seed("profiles", profile);
  const essay = await createManualTask(db, "tasks", { title: "Essay", deadline: "2026-09-25T18:00", estimatedMinutes: 300 }, { now, timeZone: TZ });
  return { db, essay };
}

test("replan writes blocks, is safe to repeat, and keeps history, manual blocks, and focus sessions", async () => {
  const { db, essay } = await world();
  const past = new Date(now.getTime() - 2 * 3_600_000).toISOString();
  const pastEnd = new Date(now.getTime() - 3_600_000).toISOString();
  db.seed("blocks", { userId: "demo-user", date: `BLOCK#${past}#gen-history`, blockId: "gen-history", taskId: essay.taskId, type: "STUDY", title: "Essay", start: past, end: pastEnd, generated: true, status: "PLANNED", outsidePreferredWindow: false, location: null, createdAt: past });
  db.seed("focus", { userId: "demo-user", sessionId: "99999999-9999-4999-8999-999999999999", taskId: essay.taskId, status: "COMPLETED", plannedMinutes: 25, startedAt: past, createdAt: past, updatedAt: past });
  const manual = await createManualBlock(db, "blocks", { type: "EVENT", title: "Club meeting", start: "2026-09-21T13:00:00.000Z", end: "2026-09-21T14:00:00.000Z" }, now);

  const first = await replan(deps(db), { now });
  assert.equal(first.blocks.reduce((sum, block) => sum + minutes(block), 0), 300);
  assert.ok(!first.blocks.some((block) => overlaps(block, manual)), "manual blocks are respected");
  const second = await replan(deps(db), { now });
  assert.deepEqual(second.blocks.map((block) => block.blockId), first.blocks.map((block) => block.blockId));

  const stored = await loadBlocks(db, "blocks", "2000", "9999");
  assert.equal(stored.filter((block) => block.generated && block.start >= now.toISOString()).length, first.blocks.length, "no duplicate blocks after a repeat");
  assert.ok(stored.some((block) => block.blockId === "gen-history"), "past blocks are history");
  assert.ok(stored.some((block) => block.blockId === manual.blockId), "manual blocks survive");
  assert.equal(db.all("focus").length, 1, "focus history is untouched");
});

test("completing a task removes its future blocks; reopening lets the planner bring them back", async () => {
  const { db, essay } = await world();
  await replan(deps(db), { now });
  await completeTask(db, "tasks", essay.taskId, now);
  assert.ok(await removeFutureTaskBlocks(db, "blocks", essay.taskId, now) > 0);
  const context = await ensurePlanFresh(deps(db), now);
  assert.equal(context.replanned, true, "the completion changed the plan inputs");
  const range = await plannerRange(deps(db), { from: "2026-09-21", to: "2026-09-27" }, now, context);
  assert.equal(range.blocks.filter((block) => block.type === "STUDY").length, 0);
});

test("cancelled tasks are invalidated at read time even when auto-scheduling is off", async () => {
  const { db, essay } = await world();
  await replan(deps(db), { now });
  const row = db.get("tasks", { userId: "demo-user", taskId: essay.taskId });
  db.seed("tasks", { ...row, status: "CANCELLED", cancelledAt: now.toISOString() });
  db.seed("profiles", { ...db.get("profiles", { userId: "demo-user" }), planning: { ...prefs, autoScheduleStudyBlocks: false } });
  const context = await ensurePlanFresh(deps(db), now);
  const range = await plannerRange(deps(db), { from: "2026-09-21", to: "2026-09-27" }, now, context);
  assert.equal(range.blocks.length, 0);
});

test("autoScheduleStudyBlocks=false reports capacity but creates no generated blocks", async () => {
  const { db } = await world(profileRow({ planning: { ...prefs, autoScheduleStudyBlocks: false } }));
  const context = await ensurePlanFresh(deps(db), now);
  assert.equal(context.replanned, true);
  assert.equal((await loadBlocks(db, "blocks", "2000", "9999")).length, 0);
  assert.ok(context.planningState.capacity, "capacity is still computed");
  assert.equal((await ensurePlanFresh(deps(db), now)).replanned, false, "unchanged inputs do not replan again");
});

test("changing preferences changes future scheduling only", async () => {
  const { db } = await world();
  const before = await replan(deps(db), { now });
  assert.ok(before.blocks.every((block) => istTime(block.start) >= "18:00"));
  db.seed("profiles", { ...db.get("profiles", { userId: "demo-user" }), planning: { ...prefs, preferredStudyStart: "09:30", preferredStudyEnd: "12:00" } });
  const context = await ensurePlanFresh(deps(db), now);
  assert.equal(context.replanned, true);
  const range = await plannerRange(deps(db), { from: "2026-09-21", to: "2026-10-04" }, now, context);
  assert.ok(range.blocks.every((block) => istTime(block.start) >= "09:30" && istTime(block.end) <= "12:00"));
});

test("the planner range returns only the requested week, and manual blocks are deletable", async () => {
  const { db } = await world();
  const context = await ensurePlanFresh(deps(db), now);
  const range = await plannerRange(deps(db), { from: "2026-09-21", to: "2026-09-21" }, now, context);
  assert.ok(range.classes.every((item) => item.date === "2026-09-21"));
  assert.ok(range.blocks.every((block) => istDay(block.start) === "2026-09-21"));
  assert.deepEqual(range.deadlines, [], "the essay is due outside this one-day range");
  const manual = await createManualBlock(db, "blocks", { type: "OTHER", title: "Gym", start: "2026-09-21T01:00:00.000Z", end: "2026-09-21T02:00:00.000Z" }, now);
  await deleteManualBlock(db, "blocks", manual.blockId);
  const generated = (await loadBlocks(db, "blocks", "2000", "9999")).find((block) => block.generated);
  await assert.rejects(() => deleteManualBlock(db, "blocks", generated.blockId), (error) => error.code === "CONFLICT");
});

test("the calendar export is valid iCalendar in UTC with escaped text", async () => {
  const { db } = await world(profileRow({ timetableSlots: [slot("Monday", "19:00", "20:00", "Algorithms, Part 1")] }));
  const context = await ensurePlanFresh(deps(db), now);
  const ics = toICS(await plannerRange(deps(db), { from: "2026-09-21", to: "2026-09-27" }, now, context), now);
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.match(ics, /SUMMARY:Algorithms\\, Part 1 \(Lecture\)/);
  assert.match(ics, /DTSTART:20260921T133000Z/, "19:00 IST in UTC");
  assert.match(ics, /SUMMARY:Due: Essay/);
  assert.ok(ics.split("\r\n").every((line) => Buffer.byteLength(line) <= 75));
});
