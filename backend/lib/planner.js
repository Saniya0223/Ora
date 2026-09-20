import { createHash, randomUUID } from "node:crypto";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { ApiError, notFound, validate } from "./api.js";
import { BLOCK_KEY_PREFIX, BLOCK_TYPES, blockKey, blockRecordSchema } from "./domain.js";
import { PRIORITY_RANK } from "./priority.js";
import { USER_ID, batchWrite, deleteItem, queryUser } from "./store.js";
import { priorityOf, reconcileTasks, remainingMinutes } from "./tasks.js";
import { loadProfile, profilePreferences, profileTimeZone, requireProfile } from "./student-profile.js";
import { addDays, daysBetween, localParts, minutesOf, zonedInstant } from "./zone.js";

// ---------------------------------------------------------------------------
// Scheduling constants (minutes unless noted)
// ---------------------------------------------------------------------------
export const HORIZON_DAYS = 14;     // how far ahead study is placed
const MAX_BLOCK = 120;              // longest single study block
const MIN_BLOCK = 30;               // shortest block, except a task's final remainder
const BREAK = 10;                   // gap kept after every placed block
const TASK_DAILY_CAP = 180;         // soft cap: first try to spread one task over days
const GRID_MS = 5 * 60_000;         // block starts land on a 5-minute grid
const EXTENDED_WINDOW = { start: "08:00", end: "22:00" }; // fallback when the preferred window is full
const MIN_MS = 60_000;

const ceilGrid = (ms) => Math.ceil(ms / GRID_MS) * GRID_MS;
const hashId = (...parts) => `gen-${createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 24)}`;

// ---------------------------------------------------------------------------
// Timetable -> concrete class occurrences
// ---------------------------------------------------------------------------

export function classOccurrences(slots, fromDate, toDate, timeZone) {
  const occurrences = [];
  for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
    const weekday = localParts(zonedInstant(date, "12:00", timeZone), timeZone).weekday;
    slots.forEach((slot, index) => {
      if (slot.day !== weekday) return;
      const slotId = slot.id ?? null;
      occurrences.push({
        id: `class:${slotId ?? `index-${index}`}:${date}`,
        slotId,
        date,
        type: slot.type === "Lab" ? "LAB" : "CLASS",
        classType: slot.type,
        title: slot.subject,
        start: new Date(zonedInstant(date, slot.startTime, timeZone)).toISOString(),
        end: new Date(zonedInstant(date, slot.endTime, timeZone)).toISOString(),
        location: slot.room || null,
      });
    });
  }
  return occurrences.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// The deterministic scheduler (pure)
// ---------------------------------------------------------------------------

function subtract(interval, busy) {
  let free = [interval];
  for (const [start, end] of busy) {
    free = free.flatMap(([a, b]) => {
      if (end <= a || start >= b) return [[a, b]];
      return [...(start > a ? [[a, start]] : []), ...(end < b ? [[end, b]] : [])];
    });
  }
  return free;
}

function formatDeadline(iso, timeZone) {
  return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

const durationText = (minutes) => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours ? `${hours} h` : "", rest ? `${rest} min` : ""].filter(Boolean).join(" ") || "0 min";
};

// Inputs are plain values; nothing here reads the clock or the database, so
// identical inputs always yield identical blocks and identical block IDs.
//
//   tasks       open tasks: { taskId, title, deadline, remainingMinutes, effectivePriority, createdAt }
//   classes     class occurrences (busy when avoidClassConflicts is on)
//   keptBlocks  blocks that survive replanning: manual ones and started/past generated ones
export function planStudyBlocks({ tasks, classes, keptBlocks, preferences, timeZone, now }) {
  const nowMs = now.getTime();
  const today = localParts(nowMs, timeZone).date;
  const lastDay = addDays(today, HORIZON_DAYS - 1);
  const horizonEndMs = zonedInstant(addDays(lastDay, 1), "00:00", timeZone);
  const dailyLimit = Math.round(preferences.dailyStudyHours * 60);
  const days = new Map(Array.from({ length: HORIZON_DAYS }, (_, index) => {
    const date = addDays(today, index);
    return [date, { date, busy: [], studyUsed: 0 }];
  }));
  const dayOf = (ms) => days.get(localParts(ms, timeZone).date);

  const keptFuture = new Map();
  for (const block of keptBlocks) {
    const start = Date.parse(block.start);
    const end = Date.parse(block.end);
    const day = dayOf(start);
    if (day) {
      day.busy.push([start, end + BREAK * MIN_MS]);
      if (block.type === "STUDY") day.studyUsed += Math.round((end - start) / MIN_MS);
    }
    // Work already booked for a task, from now on, is not booked twice.
    if (block.type === "STUDY" && block.taskId && end > nowMs) {
      keptFuture.set(block.taskId, (keptFuture.get(block.taskId) ?? 0) + Math.round((end - Math.max(start, nowMs)) / MIN_MS));
    }
  }
  if (preferences.avoidClassConflicts) {
    for (const occurrence of classes) {
      const start = Date.parse(occurrence.start);
      dayOf(start)?.busy.push([start, Date.parse(occurrence.end)]);
    }
  }

  const windowFor = (date, extended) => {
    const start = extended ? Math.min(minutesOf(EXTENDED_WINDOW.start), minutesOf(preferences.preferredStudyStart)) : minutesOf(preferences.preferredStudyStart);
    const end = extended ? Math.max(minutesOf(EXTENDED_WINDOW.end), minutesOf(preferences.preferredStudyEnd)) : minutesOf(preferences.preferredStudyEnd);
    const clock = (value) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
    return [zonedInstant(date, clock(start), timeZone), zonedInstant(date, clock(end), timeZone)];
  };
  const preferredWindow = (date) => windowFor(date, false);

  const ordered = [...tasks].sort((a, b) => PRIORITY_RANK[a.effectivePriority] - PRIORITY_RANK[b.effectivePriority]
    || (a.deadline ? Date.parse(a.deadline) : Infinity) - (b.deadline ? Date.parse(b.deadline) : Infinity)
    || a.createdAt.localeCompare(b.createdAt) || a.taskId.localeCompare(b.taskId));

  const blocks = [];
  const items = [];
  const unestimatedTasks = [];
  const deferred = [];
  for (const task of ordered) {
    if (task.remainingMinutes === null) { unestimatedTasks.push({ taskId: task.taskId, title: task.title, deadline: task.deadline }); continue; }
    const required = task.remainingMinutes;
    let remaining = required - (keptFuture.get(task.taskId) ?? 0);
    if (remaining <= 0) continue;
    const deadlineMs = task.deadline ? Date.parse(task.deadline) : Infinity;
    if (deadlineMs <= nowMs) {
      items.push({ taskId: task.taskId, title: task.title, deadline: task.deadline, requiredMinutes: required, scheduledMinutes: 0, unscheduledMinutes: remaining, reason: "DEADLINE_PASSED", message: `${task.title} is past its deadline with ${durationText(remaining)} of work remaining.` });
      continue;
    }
    const placedToday = new Map();
    let scheduled = 0;
    // Soft preferences give way, in order, only for work that would not fit:
    //   1. preferred window, at most TASK_DAILY_CAP of this task per day
    //   2. preferred window, no per-task cap (deadline pressure beats spreading)
    //   3. the wider day window
    // The daily study limit and busy time are hard limits in every pass.
    for (const [extended, capped] of [[false, true], [false, false], [true, false]]) {
      for (const day of days.values()) {
        if (remaining <= 0) break;
        const [windowStart, windowEnd] = windowFor(day.date, extended);
        if (windowStart >= deadlineMs) break;
        let dayCap = Math.min(dailyLimit - day.studyUsed, capped ? TASK_DAILY_CAP - (placedToday.get(day.date) ?? 0) : Number.POSITIVE_INFINITY);
        const bound = [ceilGrid(Math.max(windowStart, nowMs)), Math.min(windowEnd, deadlineMs)];
        if (bound[0] >= bound[1]) continue;
        for (const [freeStart, freeEnd] of subtract(bound, day.busy.sort((a, b) => a[0] - b[0]))) {
          let cursor = ceilGrid(freeStart);
          while (remaining > 0 && dayCap > 0) {
            const available = Math.floor((freeEnd - cursor) / MIN_MS);
            const chunk = Math.min(remaining, dayCap, MAX_BLOCK, available);
            // Avoid slivers, but allow a short final remainder to finish a task.
            if (chunk <= 0 || (chunk < MIN_BLOCK && chunk < remaining)) break;
            const start = cursor;
            const end = start + chunk * MIN_MS;
            const [preferredStart, preferredEnd] = preferredWindow(day.date);
            const startIso = new Date(start).toISOString();
            const endIso = new Date(end).toISOString();
            blocks.push({
              blockId: hashId(task.taskId, startIso, endIso), taskId: task.taskId, type: "STUDY", title: task.title,
              start: startIso, end: endIso, generated: true, status: "PLANNED",
              outsidePreferredWindow: start < preferredStart || end > preferredEnd, location: null,
            });
            day.busy.push([start, end + BREAK * MIN_MS]);
            day.studyUsed += chunk;
            dayCap -= chunk;
            remaining -= chunk;
            scheduled += chunk;
            placedToday.set(day.date, (placedToday.get(day.date) ?? 0) + chunk);
            cursor = ceilGrid(end + BREAK * MIN_MS);
          }
          if (remaining <= 0 || dayCap <= 0) break;
        }
      }
      if (remaining <= 0) break;
    }
    if (remaining > 0) {
      // Work due beyond the planning horizon is not at risk yet; it is planned
      // as the horizon moves forward.
      if (deadlineMs > horizonEndMs) deferred.push({ taskId: task.taskId, title: task.title, deadline: task.deadline, unscheduledMinutes: remaining });
      else items.push({
        taskId: task.taskId, title: task.title, deadline: task.deadline, requiredMinutes: required, scheduledMinutes: scheduled,
        unscheduledMinutes: remaining, reason: "INSUFFICIENT_CAPACITY",
        message: `${durationText(remaining)} of ${task.title} cannot fit before ${formatDeadline(task.deadline, timeZone)}.`,
      });
    }
  }
  const totalUnscheduledMinutes = items.reduce((sum, item) => sum + item.unscheduledMinutes, 0);
  return {
    blocks: blocks.sort((a, b) => a.start.localeCompare(b.start) || a.blockId.localeCompare(b.blockId)),
    capacity: { atRisk: items.length > 0, totalUnscheduledMinutes, items, unestimatedTasks, deferred },
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function loadBlocks(db, tableName, fromIso, toIso) {
  const rows = await queryUser(db, tableName, { sortKey: "date", between: [`${BLOCK_KEY_PREFIX}${fromIso}`, `${BLOCK_KEY_PREFIX}${toIso}~`] });
  return rows.map((row) => blockRecordSchema.parse(row));
}

const loadFutureBlocks = (db, tableName, nowMs) => loadBlocks(db, tableName, new Date(nowMs - 36 * 3_600_000).toISOString(), "9999");

export function blockDTO(block, now, taskStatus) {
  const invalidated = block.generated && block.taskId !== null && taskStatus !== "OPEN";
  return {
    id: block.blockId, taskId: block.taskId, type: block.type, title: block.title, start: block.start, end: block.end,
    generated: block.generated, status: invalidated ? "INVALIDATED" : block.status,
    isPast: Date.parse(block.end) <= now.getTime(), outsidePreferredWindow: block.outsidePreferredWindow, location: block.location,
  };
}

// The plan's inputs, hashed. A new fingerprint means the saved plan is stale.
function fingerprint({ today, preferences, timeZone, slots, openTasks, keptBlocks }) {
  return createHash("sha1").update(JSON.stringify({
    today, preferences, timeZone, slots,
    tasks: openTasks.map((task) => [task.taskId, task.deadline, task.remainingMinutes, task.effectivePriority]),
    kept: keptBlocks.filter((block) => !block.generated).map((block) => [block.blockId, block.start, block.end, block.taskId]),
  })).digest("hex");
}

// Gather every input the scheduler needs, from the current database state.
export async function planningInputs(dependencies, now) {
  const { db, tables, env } = dependencies;
  const profile = requireProfile(await loadProfile(db, tables.profile));
  const preferences = profilePreferences(profile, env);
  const timeZone = profileTimeZone(profile);
  const tasks = await reconcileTasks(db, tables, now);
  const dailyStudyMinutes = preferences.dailyStudyHours * 60;
  const openTasks = tasks.filter((task) => task.status === "OPEN").map((task) => ({
    taskId: task.taskId, title: task.title, deadline: task.deadline, createdAt: task.createdAt,
    remainingMinutes: remainingMinutes(task), effectivePriority: priorityOf(task, now, dailyStudyMinutes).effective,
  }));
  const nowMs = now.getTime();
  const existing = await loadFutureBlocks(db, tables.blocks, nowMs);
  const keptBlocks = existing.filter((block) => !block.generated || Date.parse(block.start) < nowMs);
  const replaceable = existing.filter((block) => block.generated && Date.parse(block.start) >= nowMs);
  const today = localParts(nowMs, timeZone).date;
  const classes = classOccurrences(profile.timetableSlots, today, addDays(today, HORIZON_DAYS), timeZone);
  return { profile, preferences, timeZone, slots: profile.timetableSlots, tasks, openTasks, keptBlocks, replaceable, classes, today };
}

async function savePlanningState(db, tableName, state) {
  await db.send(new UpdateCommand({
    TableName: tableName, Key: { userId: USER_ID }, UpdateExpression: "SET #p = :p",
    ExpressionAttributeNames: { "#p": "planningState" }, ExpressionAttributeValues: { ":p": state },
    ConditionExpression: "attribute_exists(userId)",
  }));
}

// Replace eligible future generated blocks with a fresh plan. Kept intact:
// timetable classes (never stored as blocks), manual blocks, past or started
// generated blocks, and focus-session history. Safe to repeat: identical
// inputs rebuild identical block IDs, so a repeat rewrites the same rows.
//
// generate=false computes capacity without writing any study blocks; it is used
// when the student turned autoScheduleStudyBlocks off.
export async function replan(dependencies, { now = new Date(), generate = true, inputs } = {}) {
  const { db, tables } = dependencies;
  const data = inputs ?? await planningInputs(dependencies, now);
  const plan = planStudyBlocks({ tasks: data.openTasks, classes: data.classes, keptBlocks: data.keptBlocks, preferences: data.preferences, timeZone: data.timeZone, now });
  const blocks = generate ? plan.blocks : [];
  const keep = new Set(blocks.map((block) => block.blockId));
  const createdAt = now.toISOString();
  const deletes = data.replaceable.filter((block) => !keep.has(block.blockId)).map((block) => ({ DeleteRequest: { Key: { userId: USER_ID, date: block.date } } }));
  const puts = blocks.map((block) => ({ PutRequest: { Item: blockRecordSchema.parse({ userId: USER_ID, date: blockKey(block.start, block.blockId), ...block, createdAt }) } }));
  await batchWrite(db, tables.blocks, [...deletes, ...puts]);
  const state = {
    lastPlannedAt: createdAt, generated: generate, fingerprint: fingerprint(data),
    capacity: plan.capacity, blockCount: blocks.length,
  };
  await savePlanningState(db, tables.profile, state);
  return { plannedAt: createdAt, generated: generate, removed: deletes.length, blocks, capacity: plan.capacity };
}

// Called by read endpoints. Replans only when an input changed since the last
// plan, so repeated reads are cheap and do not churn the schedule.
export async function ensurePlanFresh(dependencies, now) {
  const inputs = await planningInputs(dependencies, now);
  const state = inputs.profile.planningState ?? {};
  const current = fingerprint(inputs);
  if (state.fingerprint === current) return { inputs, planningState: state, replanned: false };
  const result = await replan(dependencies, { now, generate: inputs.preferences.autoScheduleStudyBlocks, inputs });
  const refreshed = { lastPlannedAt: result.plannedAt, generated: result.generated, fingerprint: current, capacity: result.capacity, blockCount: result.blocks.length };
  return { inputs, planningState: refreshed, replanned: true };
}

// Completing, cancelling, or deleting a task frees its future generated blocks.
export async function removeFutureTaskBlocks(db, tableName, taskId, now) {
  const blocks = (await loadFutureBlocks(db, tableName, now.getTime()))
    .filter((block) => block.generated && block.taskId === taskId && Date.parse(block.start) >= now.getTime());
  await batchWrite(db, tableName, blocks.map((block) => ({ DeleteRequest: { Key: { userId: USER_ID, date: block.date } } })));
  return blocks.length;
}

// ---------------------------------------------------------------------------
// Manual blocks
// ---------------------------------------------------------------------------

export const manualBlockSchema = z.strictObject({
  type: z.enum(BLOCK_TYPES),
  title: z.string().trim().min(1).max(300),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  taskId: z.uuid().nullable().optional(),
  location: z.string().trim().max(200).nullable().optional(),
}).refine((value) => Date.parse(value.end) > Date.parse(value.start), { message: "A block must end after it starts", path: ["end"] })
  .refine((value) => Date.parse(value.end) - Date.parse(value.start) <= 12 * 3_600_000, { message: "A block can be at most 12 hours long", path: ["end"] });

export async function createManualBlock(db, tableName, body, now) {
  const input = validate(manualBlockSchema, body);
  const start = new Date(input.start).toISOString();
  const blockId = randomUUID();
  const record = blockRecordSchema.parse({
    userId: USER_ID, date: blockKey(start, blockId), blockId, taskId: input.taskId ?? null, type: input.type, title: input.title,
    start, end: new Date(input.end).toISOString(), generated: false, status: "PLANNED", outsidePreferredWindow: false,
    location: input.location ?? null, createdAt: now.toISOString(),
  });
  await batchWrite(db, tableName, [{ PutRequest: { Item: record } }]);
  return record;
}

export async function deleteManualBlock(db, tableName, blockId) {
  const rows = (await queryUser(db, tableName, { sortKey: "date", beginsWith: BLOCK_KEY_PREFIX })).filter((row) => row.blockId === blockId);
  if (!rows.length) throw notFound("block");
  const block = blockRecordSchema.parse(rows[0]);
  if (block.generated) throw new ApiError(409, "CONFLICT", "Generated study blocks are managed by the planner. Replan instead of deleting them.");
  await deleteItem(db, tableName, { userId: USER_ID, date: block.date });
}

// ---------------------------------------------------------------------------
// Range reads and calendar export
// ---------------------------------------------------------------------------

export const rangeSchema = z.strictObject({ from: z.iso.date(), to: z.iso.date() })
  .refine((value) => value.to >= value.from, { message: "to must not be before from", path: ["to"] })
  .refine((value) => daysBetween(value.from, value.to) <= 41, { message: "A range may cover at most 42 days", path: ["to"] });

export async function plannerRange(dependencies, { from, to }, now, context) {
  const { db, tables } = dependencies;
  const { inputs, planningState } = context;
  const fromMs = zonedInstant(from, "00:00", inputs.timeZone);
  const toMs = zonedInstant(addDays(to, 1), "00:00", inputs.timeZone);
  const status = new Map(inputs.tasks.map((task) => [task.taskId, task.status]));
  const blocks = (await loadBlocks(db, tables.blocks, new Date(fromMs - 24 * 3_600_000).toISOString(), new Date(toMs).toISOString()))
    .filter((block) => Date.parse(block.end) > fromMs && Date.parse(block.start) < toMs)
    .map((block) => blockDTO(block, now, block.taskId ? status.get(block.taskId) : "OPEN"))
    .filter((block) => block.status !== "INVALIDATED");
  const classes = classOccurrences(inputs.profile.timetableSlots, from, to, inputs.timeZone);
  const deadlines = inputs.tasks
    .filter((task) => task.deadline && task.status !== "CANCELLED" && Date.parse(task.deadline) >= fromMs && Date.parse(task.deadline) < toMs)
    .sort((a, b) => a.deadline.localeCompare(b.deadline))
    .map((task) => ({ taskId: task.taskId, title: task.title, type: task.type, course: task.course, deadline: task.deadline, status: task.status }));
  return { range: { from, to, timezone: inputs.timeZone }, classes, blocks, deadlines, capacity: planningState.capacity ?? null, planning: { lastPlannedAt: planningState.lastPlannedAt ?? null, autoScheduleStudyBlocks: inputs.preferences.autoScheduleStudyBlocks } };
}

const icsText = (value) => String(value).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsTime = (iso) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
function fold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest, "utf8") > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut), "utf8") > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join("\r\n");
}

// RFC 5545 calendar of classes, study blocks, and deadlines, all in UTC.
export function toICS(range, now) {
  const stamp = icsTime(now.toISOString());
  const events = [
    ...range.classes.map((item) => ({ uid: `${item.id}@campusflow`, start: item.start, end: item.end, summary: `${item.title} (${item.classType})`, location: item.location, category: item.type })),
    ...range.blocks.map((item) => ({ uid: `${item.id}@campusflow`, start: item.start, end: item.end, summary: item.type === "STUDY" ? `Study: ${item.title}` : item.title, location: item.location, category: item.type })),
    ...range.deadlines.map((item) => ({ uid: `deadline-${item.taskId}@campusflow`, start: new Date(Date.parse(item.deadline) - 15 * MIN_MS).toISOString(), end: item.deadline, summary: `Due: ${item.title}`, location: null, category: "DEADLINE" })),
  ].sort((a, b) => a.start.localeCompare(b.start) || a.uid.localeCompare(b.uid));
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//CampusFlow//Planner//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const event of events) {
    lines.push("BEGIN:VEVENT", `UID:${event.uid}`, `DTSTAMP:${stamp}`, `DTSTART:${icsTime(event.start)}`, `DTEND:${icsTime(event.end)}`, `SUMMARY:${icsText(event.summary)}`, `CATEGORIES:${event.category}`);
    if (event.location) lines.push(`LOCATION:${icsText(event.location)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
