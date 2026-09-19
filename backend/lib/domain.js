import { z } from "zod";

// Persisted shapes for the student-facing layer: Tasks, focus sessions, and
// planner blocks. AcademicEvents stay the source-backed truth in contracts.js;
// a Task is what the student acts on and may reference one AcademicEvent.
//
// Rows are parsed with defaults rather than strictly, so a row written before a
// field existed still loads. Unknown attributes are dropped on read.

export const TASK_TYPES = ["EXAM", "ASSIGNMENT", "LAB", "LECTURE", "ADMIN", "CLUB", "OTHER"];
export const TASK_STATUSES = ["OPEN", "COMPLETED", "CANCELLED"];
export const PRIORITIES = ["HIGH", "MEDIUM", "LOW"];
export const TASK_SOURCES = ["CLASSROOM", "MANUAL_NOTICE", "PDF", "MANUAL"];
export const BLOCK_TYPES = ["STUDY", "CLASS", "LAB", "EVENT", "OTHER"];

const timestamp = z.iso.datetime({ offset: true });

export const EVENT_TYPE_TO_TASK_TYPE = { Exam: "EXAM", Assignment: "ASSIGNMENT", Lab: "LAB", Lecture: "LECTURE", Admin: "ADMIN", Club: "CLUB" };
export const EVENT_SOURCE_TO_TASK_SOURCE = { classroom: "CLASSROOM", manual: "MANUAL_NOTICE", pdf: "PDF" };

export const checklistItemSchema = z.object({
  id: z.uuid(),
  text: z.string().min(1).max(300),
  done: z.boolean().default(false),
  createdAt: timestamp,
  completedAt: timestamp.nullable().default(null),
});

export const attachmentSchema = z.object({
  id: z.uuid(),
  fileName: z.string().min(1).max(200),
  contentType: z.string().min(1).max(100),
  size: z.number().int().positive(),
  s3Key: z.string().min(1),
  status: z.enum(["PENDING", "READY"]).default("PENDING"),
  createdAt: timestamp,
});

const workUnitSchema = z.object({ title: z.string().min(1).max(120), minutes: z.number().int().min(5).max(600) });

export const aiEstimateSchema = z.object({
  estimatedMinutes: z.number().int().min(15).max(2400),
  workUnits: z.array(workUnitSchema).max(8).default([]),
  rationale: z.string().max(400).default(""),
  model: z.string().max(100).nullable().default(null),
  generatedAt: timestamp,
});

export const taskRecordSchema = z.object({
  userId: z.string().min(1),
  taskId: z.uuid(),
  version: z.number().int().nonnegative().default(0),
  academicEventId: z.uuid().nullable().default(null),
  source: z.enum(TASK_SOURCES).default("MANUAL"),
  sourceRef: z.string().nullable().default(null),
  sourceStatus: z.enum(["ACTIVE", "CANCELLED", "DONE"]).nullable().default(null),
  title: z.string().min(1).max(300),
  course: z.object({ id: z.string().nullable(), name: z.string().nullable() }).nullable().default(null),
  type: z.enum(TASK_TYPES).default("OTHER"),
  deadline: timestamp.nullable().default(null),
  status: z.enum(TASK_STATUSES).default("OPEN"),
  completedAt: timestamp.nullable().default(null),
  cancelledAt: timestamp.nullable().default(null),
  manualPriorityOverride: z.enum(PRIORITIES).nullable().default(null),
  // Effort in minutes. null means unknown, never zero. The effective estimate
  // prefers the student's own figure, then the source's, then the AI's.
  studentEstimatedMinutes: z.number().int().min(1).max(10_000).nullable().default(null),
  sourceEstimatedMinutes: z.number().int().min(1).max(10_000).nullable().default(null),
  aiEstimate: aiEstimateSchema.nullable().default(null),
  actualMinutes: z.number().int().nonnegative().default(0),
  bookmarked: z.boolean().default(false),
  notes: z.string().max(20_000).default(""),
  checklist: z.array(checklistItemSchema).max(100).default([]),
  attachments: z.array(attachmentSchema).max(20).default([]),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const focusSessionRecordSchema = z.object({
  userId: z.string().min(1),
  sessionId: z.uuid(),
  version: z.number().int().nonnegative().default(0),
  taskId: z.uuid(),
  taskTitle: z.string().default(""),
  status: z.enum(["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"]),
  plannedMinutes: z.number().int().min(1).max(240),
  startedAt: timestamp,
  // Seconds of focus accrued before the current running stretch.
  accumulatedSeconds: z.number().int().nonnegative().default(0),
  // Start of the current running stretch; null while paused or finished.
  runningSince: timestamp.nullable().default(null),
  pausedAt: timestamp.nullable().default(null),
  completedAt: timestamp.nullable().default(null),
  cancelledAt: timestamp.nullable().default(null),
  completedMinutes: z.number().int().nonnegative().nullable().default(null),
  createdAt: timestamp,
  updatedAt: timestamp,
});

// Planner blocks live in the existing ScheduleBlocks table beside the legacy
// one-row-per-day documents. Their sort key (the table's `date` attribute) is
// `BLOCK#<startISO>#<blockId>`, so a date range is one key-range Query.
export const BLOCK_KEY_PREFIX = "BLOCK#";
export const blockKey = (start, blockId) => `${BLOCK_KEY_PREFIX}${start}#${blockId}`;

export const blockRecordSchema = z.object({
  userId: z.string().min(1),
  date: z.string().startsWith(BLOCK_KEY_PREFIX),
  blockId: z.string().min(1),
  taskId: z.uuid().nullable().default(null),
  type: z.enum(BLOCK_TYPES),
  title: z.string().min(1).max(300),
  start: timestamp,
  end: timestamp,
  generated: z.boolean(),
  status: z.enum(["PLANNED"]).default("PLANNED"),
  outsidePreferredWindow: z.boolean().default(false),
  location: z.string().max(200).nullable().default(null),
  createdAt: timestamp,
});
