import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, notFound, validate } from "./api.js";
import { academicEventSchema } from "./contracts.js";
import { EVENT_SOURCE_TO_TASK_SOURCE, EVENT_TYPE_TO_TASK_TYPE, PRIORITIES, TASK_TYPES, taskRecordSchema, taskSourceDetailsSchema } from "./domain.js";
import { PRIORITY_RANK, calculatePriority } from "./priority.js";
import { USER_ID, getItem, putNew, queryUser, updateVersioned } from "./store.js";
import { deadlineInstant } from "./time.js";
import { localParts, zonedInstant } from "./zone.js";

const taskKey = (taskId) => ({ userId: USER_ID, taskId });
const parseTask = (row) => taskRecordSchema.parse(row);

// ---------------------------------------------------------------------------
// Effort, progress, and the public DTO
// ---------------------------------------------------------------------------

// The student's figure wins, then the source's, then the AI's. null = unknown.
export function effectiveEstimate(task) {
  if (task.studentEstimatedMinutes !== null) return { minutes: task.studentEstimatedMinutes, source: "STUDENT" };
  if (task.sourceEstimatedMinutes !== null) return { minutes: task.sourceEstimatedMinutes, source: "SOURCE" };
  if (task.aiEstimate) return { minutes: task.aiEstimate.estimatedMinutes, source: "AI" };
  return { minutes: null, source: null };
}

export function remainingMinutes(task) {
  const { minutes } = effectiveEstimate(task);
  return minutes === null ? null : Math.max(0, minutes - task.actualMinutes);
}

export function priorityOf(task, now, dailyStudyMinutes) {
  if (task.status !== "OPEN") return { calculated: null, reason: null, effective: null };
  const { level, reason } = calculatePriority({ deadline: task.deadline, type: task.type, remainingMinutes: remainingMinutes(task) }, now, dailyStudyMinutes);
  return { calculated: level, reason, effective: task.manualPriorityOverride ?? level };
}

export const publicAttachment = ({ s3Key, ...attachment }) => attachment;

// Progress keeps two separate meanings: study time against the estimate, and
// checklist completion. They are never blended into one percentage.
export function toTaskDTO(task, { now, dailyStudyMinutes }, { detail = false } = {}) {
  const estimate = effectiveEstimate(task);
  const remaining = remainingMinutes(task);
  const priority = priorityOf(task, now, dailyStudyMinutes);
  const done = task.checklist.filter((item) => item.done).length;
  const total = task.checklist.length;
  const dto = {
    id: task.taskId,
    academicEventId: task.academicEventId,
    isSourceBacked: task.academicEventId !== null,
    source: task.source,
    sourceRef: task.sourceRef,
    sourceStatus: task.sourceStatus,
    title: task.title,
    course: task.course,
    type: task.type,
    deadline: task.deadline,
    status: task.status,
    completedAt: task.completedAt,
    cancelledAt: task.cancelledAt,
    isOverdue: task.status === "OPEN" && task.deadline !== null && Date.parse(task.deadline) < now.getTime(),
    calculatedPriority: priority.calculated,
    priorityReason: priority.reason,
    manualPriorityOverride: task.manualPriorityOverride,
    effectivePriority: priority.effective,
    estimatedMinutes: estimate.minutes,
    estimateSource: estimate.source,
    actualMinutes: task.actualMinutes,
    remainingMinutes: remaining,
    progress: {
      timePercent: estimate.minutes ? Math.min(100, Math.round((task.actualMinutes / estimate.minutes) * 100)) : null,
      actualMinutes: task.actualMinutes,
      estimatedMinutes: estimate.minutes,
    },
    checklistProgress: { done, total, percent: total ? Math.round((done / total) * 100) : null },
    bookmarked: task.bookmarked,
    attachmentCount: task.attachments.filter((attachment) => attachment.status === "READY").length,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    version: task.version,
  };
  if (!detail) return dto;
  return {
    ...dto,
    studentEstimatedMinutes: task.studentEstimatedMinutes,
    sourceEstimatedMinutes: task.sourceEstimatedMinutes,
    aiEstimate: task.aiEstimate,
    details: task.details,
    notes: task.notes,
    checklist: task.checklist,
    attachments: task.attachments.map(publicAttachment),
  };
}

// ---------------------------------------------------------------------------
// AcademicEvent -> Task
// ---------------------------------------------------------------------------

// Classroom sourceRef is `<courseId>:<kind>:<itemId>`.
const classroomCourseId = (event) => (event.sourceType === "classroom" && event.sourceRef ? event.sourceRef.split(":")[0] : null);

// Events stored before structured details existed, with no venue, carry no
// detail; their Tasks keep `details: null` rather than being rewritten.
function sourceDetails(event) {
  if (!event.details && !event.sourceMeta && !event.venue) return null;
  return taskSourceDetailsSchema.parse({
    ...(event.details ?? {}),
    venue: event.venue,
    postedAt: event.sourceMeta?.postedAt ?? null,
    updatedAt: event.sourceMeta?.updatedAt ?? null,
  });
}

function sourceFields(event, courseName) {
  const courseId = classroomCourseId(event);
  return {
    academicEventId: event.eventId,
    source: EVENT_SOURCE_TO_TASK_SOURCE[event.sourceType] ?? "MANUAL_NOTICE",
    sourceRef: event.sourceRef,
    sourceStatus: event.status,
    title: event.title,
    type: EVENT_TYPE_TO_TASK_TYPE[event.type] ?? "OTHER",
    deadline: event.currentDeadline ? new Date(deadlineInstant(event.currentDeadline)).toISOString() : null,
    details: sourceDetails(event),
    // The truth prompt answers 0 when it does not know the effort, so 0 from a
    // source is treated as unknown rather than as "no work required".
    sourceEstimatedMinutes: event.estimatedHours > 0 ? Math.min(10_000, Math.max(1, Math.round(event.estimatedHours * 60))) : null,
    course: courseId ? { id: courseId, name: courseName ?? null } : null,
  };
}

const SOURCE_KEYS = ["academicEventId", "source", "sourceRef", "sourceStatus", "title", "type", "deadline", "sourceEstimatedMinutes"];
const sameSource = (task, fields) => SOURCE_KEYS.every((key) => task[key] === fields[key])
  && JSON.stringify(task.details) === JSON.stringify(fields.details)
  && (fields.course === null || (task.course?.id === fields.course.id && (fields.course.name === null || task.course?.name === fields.course.name)));

// Idempotent: the Task for an event always has taskId = eventId, so replaying
// the same event can only update that one row. Only source-owned fields are
// written; notes, checklist, progress, and overrides are never touched.
export async function applyEventToTask(db, tableName, event, { courseName = null, now = new Date() } = {}) {
  const fields = sourceFields(event, courseName);
  const timestamp = now.toISOString();
  const cancelled = event.status === "CANCELLED";
  const fresh = parseTask({
    userId: USER_ID, taskId: event.eventId, version: 0, ...fields,
    status: cancelled ? "CANCELLED" : "OPEN", cancelledAt: cancelled ? timestamp : null,
    createdAt: timestamp, updatedAt: timestamp,
  });
  if (await putNew(db, tableName, fresh, "taskId")) return { action: "CREATED", task: fresh };
  let changed = false;
  const task = await updateVersioned(db, tableName, taskKey(event.eventId), (row) => {
    const current = parseTask(row);
    if (sameSource(current, fields) && !(cancelled && current.status === "OPEN")) return null;
    changed = true;
    // Keep a known course name when this sync only knows the course ID.
    const course = fields.course
      ? { id: fields.course.id, name: fields.course.name ?? (current.course?.id === fields.course.id ? current.course.name : null) }
      : current.course;
    const next = { ...current, ...fields, course, updatedAt: timestamp };
    // A source cancellation cancels open work. A task the student already
    // completed stays completed; sourceStatus still records the cancellation.
    if (cancelled && current.status === "OPEN") Object.assign(next, { status: "CANCELLED", cancelledAt: timestamp });
    return next;
  }, { what: "task" });
  return { action: changed ? "UPDATED" : "UNCHANGED", task: parseTask(task) };
}

// Used from ingestion. Never throws: the AcademicEvent is already committed,
// and a missed task is repaired by reconcileTasks on the next read.
export async function syncTaskForEvent(dependencies, event, courseName = null) {
  const tableName = dependencies.env?.TASKS_TABLE;
  if (!tableName || !event) return null;
  try {
    return await applyEventToTask(dependencies.db, tableName, event, { courseName, now: dependencies.now?.() ?? new Date() });
  } catch (error) {
    console.error(JSON.stringify({ code: "TASK_SYNC_FAILED", eventId: event.eventId, reason: error?.code ?? error?.name ?? "UNKNOWN" }));
    return null;
  }
}

// Ensures every AcademicEvent has a matching, up-to-date Task. Cheap when
// nothing changed: one query per table and no writes.
export async function reconcileTasks(db, tables, now = new Date()) {
  const [events, rows, courses] = await Promise.all([
    queryUser(db, tables.events).then((rows) => rows.map((row) => academicEventSchema.parse(row))),
    queryUser(db, tables.tasks),
    tables.syncState ? queryUser(db, tables.syncState) : [],
  ]);
  const courseNames = new Map(courses.filter((row) => row.courseName).map((row) => [row.courseId, row.courseName]));
  const tasks = new Map(rows.map((row) => [row.taskId, parseTask(row)]));
  for (const event of events) {
    const existing = tasks.get(event.eventId);
    const courseName = courseNames.get(classroomCourseId(event)) ?? existing?.course?.name ?? null;
    const fields = sourceFields(event, courseName);
    if (existing && sameSource(existing, fields) && !(event.status === "CANCELLED" && existing.status === "OPEN")) continue;
    const { task } = await applyEventToTask(db, tables.tasks, event, { courseName, now });
    tasks.set(task.taskId, task);
  }
  return [...tasks.values()];
}

// ---------------------------------------------------------------------------
// Reads, filtering, and counts
// ---------------------------------------------------------------------------

export const listQuerySchema = z.strictObject({
  view: z.enum(["all", "upcoming", "high_priority", "completed", "cancelled"]).default("all"),
  q: z.string().trim().max(100).optional(),
  course: z.string().trim().max(100).optional(),
  type: z.enum(TASK_TYPES).optional(),
  status: z.enum(["OPEN", "COMPLETED", "CANCELLED"]).optional(),
  bookmarked: z.enum(["true", "false"]).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  sort: z.enum(["priority", "deadline", "updated"]).default("priority"),
});

function inView(dto, view, now) {
  if (view === "all") return dto.status !== "CANCELLED";
  if (view === "upcoming") return dto.status === "OPEN" && dto.deadline !== null && Date.parse(dto.deadline) >= now.getTime();
  if (view === "high_priority") return dto.status === "OPEN" && dto.effectivePriority === "HIGH";
  if (view === "completed") return dto.status === "COMPLETED";
  return dto.status === "CANCELLED";
}

const rank = (dto) => (dto.status === "OPEN" ? 0 : dto.status === "COMPLETED" ? 1 : 2);
const deadlineOrder = (dto) => (dto.deadline ? Date.parse(dto.deadline) : Number.POSITIVE_INFINITY);
const comparators = {
  priority: (a, b) => rank(a) - rank(b) || (PRIORITY_RANK[a.effectivePriority] ?? 3) - (PRIORITY_RANK[b.effectivePriority] ?? 3) || deadlineOrder(a) - deadlineOrder(b) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
  deadline: (a, b) => rank(a) - rank(b) || deadlineOrder(a) - deadlineOrder(b) || a.id.localeCompare(b.id),
  updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
};

// Filters apply to both the list and the counts; the view/status selector
// applies to the list only, so tab counts stay stable while switching tabs.
export function filterTasks(dtos, filters, now, timeZone) {
  const q = filters.q?.toLocaleLowerCase("en");
  const course = filters.course?.toLocaleLowerCase("en");
  const localDate = (iso) => localParts(Date.parse(iso), timeZone).date;
  const base = dtos.filter((dto) => (!q || dto.title.toLocaleLowerCase("en").includes(q) || (dto.course?.name ?? "").toLocaleLowerCase("en").includes(q))
    && (!course || dto.course?.id?.toLocaleLowerCase("en") === course || dto.course?.name?.toLocaleLowerCase("en") === course)
    && (!filters.type || dto.type === filters.type)
    && (filters.bookmarked === undefined || dto.bookmarked === (filters.bookmarked === "true"))
    && (!filters.from || (dto.deadline && localDate(dto.deadline) >= filters.from))
    && (!filters.to || (dto.deadline && localDate(dto.deadline) <= filters.to)));
  const counts = {
    all: base.filter((dto) => inView(dto, "all", now)).length,
    upcoming: base.filter((dto) => inView(dto, "upcoming", now)).length,
    highPriority: base.filter((dto) => inView(dto, "high_priority", now)).length,
    completed: base.filter((dto) => inView(dto, "completed", now)).length,
    cancelled: base.filter((dto) => inView(dto, "cancelled", now)).length,
  };
  const selected = base.filter((dto) => (filters.status ? dto.status === filters.status : inView(dto, filters.view, now)));
  return { tasks: selected.sort(comparators[filters.sort]), counts };
}

export async function getTaskRecord(db, tableName, taskId) {
  if (!z.uuid().safeParse(taskId).success) throw notFound("task");
  const row = await getItem(db, tableName, taskKey(taskId));
  if (!row) throw notFound("task");
  return parseTask(row);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

// Deadlines may be ISO instants with an offset, or local "YYYY-MM-DDTHH:mm"
// interpreted in the student's zone.
const deadlineInput = z.union([z.iso.datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)]).nullable();
const toInstant = (value, timeZone) => (value === null ? null
  : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? new Date(zonedInstant(value.slice(0, 10), value.slice(11, 16), timeZone)).toISOString()
    : new Date(value).toISOString());

const minutes = z.number().int().min(1).max(10_000);

export const createTaskSchema = z.strictObject({
  title: z.string().trim().min(1).max(300),
  courseName: z.string().trim().min(1).max(100).nullable().optional(),
  type: z.enum(TASK_TYPES).default("OTHER"),
  deadline: deadlineInput.optional(),
  estimatedMinutes: minutes.nullable().optional(),
  manualPriorityOverride: z.enum(PRIORITIES).nullable().optional(),
  notes: z.string().max(20_000).optional(),
  checklist: z.array(z.string().trim().min(1).max(300)).max(100).optional(),
});

export async function createManualTask(db, tableName, body, { now, timeZone }) {
  const input = validate(createTaskSchema, body);
  const timestamp = now.toISOString();
  const task = parseTask({
    userId: USER_ID, taskId: randomUUID(), version: 0, source: "MANUAL",
    title: input.title,
    course: input.courseName ? { id: null, name: input.courseName } : null,
    type: input.type,
    deadline: toInstant(input.deadline ?? null, timeZone),
    studentEstimatedMinutes: input.estimatedMinutes ?? null,
    manualPriorityOverride: input.manualPriorityOverride ?? null,
    notes: input.notes ?? "",
    checklist: (input.checklist ?? []).map((text) => ({ id: randomUUID(), text, done: false, createdAt: timestamp, completedAt: null })),
    createdAt: timestamp, updatedAt: timestamp,
  });
  await putNew(db, tableName, task, "taskId");
  return task;
}

const SOURCE_OWNED = ["title", "courseName", "type", "deadline"];

export const updateTaskSchema = z.strictObject({
  title: z.string().trim().min(1).max(300).optional(),
  courseName: z.string().trim().min(1).max(100).nullable().optional(),
  type: z.enum(TASK_TYPES).optional(),
  deadline: deadlineInput.optional(),
  estimatedMinutes: minutes.nullable().optional(),
  manualPriorityOverride: z.enum(PRIORITIES).nullable().optional(),
  notes: z.string().max(20_000).optional(),
  bookmarked: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, { message: "Provide at least one field to change" });

export async function updateTask(db, tableName, taskId, body, { now, timeZone }) {
  const input = validate(updateTaskSchema, body);
  const current = await getTaskRecord(db, tableName, taskId);
  const blocked = current.academicEventId ? SOURCE_OWNED.filter((field) => field in input) : [];
  if (blocked.length) {
    throw new ApiError(409, "SOURCE_MANAGED", "These fields come from the connected source and cannot be edited here.", blocked.map((field) => ({ field, issue: "Managed by the source" })));
  }
  return parseTask(await updateVersioned(db, tableName, taskKey(taskId), (row) => {
    const task = parseTask(row);
    if ("title" in input) task.title = input.title;
    if ("courseName" in input) task.course = input.courseName ? { id: null, name: input.courseName } : null;
    if ("type" in input) task.type = input.type;
    if ("deadline" in input) task.deadline = toInstant(input.deadline, timeZone);
    if ("estimatedMinutes" in input) task.studentEstimatedMinutes = input.estimatedMinutes;
    if ("manualPriorityOverride" in input) task.manualPriorityOverride = input.manualPriorityOverride;
    if ("notes" in input) task.notes = input.notes;
    if ("bookmarked" in input) task.bookmarked = input.bookmarked;
    task.updatedAt = now.toISOString();
    return task;
  }, { what: "task" }));
}

export async function mutateTask(db, tableName, taskId, now, change) {
  await getTaskRecord(db, tableName, taskId);
  return parseTask(await updateVersioned(db, tableName, taskKey(taskId), (row) => {
    const task = parseTask(row);
    const result = change(task);
    if (result === null) return null;
    task.updatedAt = now.toISOString();
    return task;
  }, { what: "task" }));
}

export const completeTask = (db, tableName, taskId, now) => mutateTask(db, tableName, taskId, now, (task) => {
  if (task.status === "COMPLETED") return null;
  if (task.status === "CANCELLED") throw new ApiError(409, "CONFLICT", "A cancelled task cannot be completed.");
  Object.assign(task, { status: "COMPLETED", completedAt: now.toISOString() });
  return task;
});

export const reopenTask = (db, tableName, taskId, now) => mutateTask(db, tableName, taskId, now, (task) => {
  if (task.status === "OPEN") return null;
  if (task.status === "CANCELLED") throw new ApiError(409, "CONFLICT", "The source cancelled this task, so it cannot be reopened.");
  Object.assign(task, { status: "OPEN", completedAt: null });
  return task;
});

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

export async function addChecklistItem(db, tableName, taskId, body, now) {
  const { text } = validate(z.strictObject({ text: z.string().trim().min(1).max(300) }), body);
  const item = { id: randomUUID(), text, done: false, createdAt: now.toISOString(), completedAt: null };
  const task = await mutateTask(db, tableName, taskId, now, (current) => {
    if (current.checklist.length >= 100) throw new ApiError(409, "CONFLICT", "A checklist can hold at most 100 items.");
    current.checklist.push(item);
    return current;
  });
  return { task, item };
}

export async function updateChecklistItem(db, tableName, taskId, itemId, body, now) {
  const input = validate(z.strictObject({ text: z.string().trim().min(1).max(300).optional(), done: z.boolean().optional() })
    .refine((value) => Object.keys(value).length > 0, { message: "Provide text or done" }), body);
  return mutateTask(db, tableName, taskId, now, (task) => {
    const item = task.checklist.find((entry) => entry.id === itemId);
    if (!item) throw notFound("checklist item");
    if (input.text !== undefined) item.text = input.text;
    if (input.done !== undefined && input.done !== item.done) {
      item.done = input.done;
      item.completedAt = input.done ? now.toISOString() : null;
    }
    return task;
  });
}

export const deleteChecklistItem = (db, tableName, taskId, itemId, now) => mutateTask(db, tableName, taskId, now, (task) => {
  const index = task.checklist.findIndex((entry) => entry.id === itemId);
  if (index < 0) throw notFound("checklist item");
  task.checklist.splice(index, 1);
  return task;
});

export async function reorderChecklist(db, tableName, taskId, body, now) {
  const { itemIds } = validate(z.strictObject({ itemIds: z.array(z.uuid()).max(100) }), body);
  return mutateTask(db, tableName, taskId, now, (task) => {
    const current = task.checklist.map((item) => item.id);
    if (itemIds.length !== current.length || new Set(itemIds).size !== itemIds.length || itemIds.some((id) => !current.includes(id))) {
      throw new ApiError(400, "VALIDATION_ERROR", "itemIds must list every checklist item exactly once.", [{ field: "itemIds", issue: "Must be a permutation of the current item IDs" }]);
    }
    task.checklist = itemIds.map((id) => task.checklist.find((item) => item.id === id));
    return task;
  });
}
