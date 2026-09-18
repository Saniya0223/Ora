import { z } from "zod";

const eventType = z.enum(["Exam", "Assignment", "Admin", "Lecture", "Club", "Lab"]);
const priority = z.enum(["High", "Medium", "Low"]);
const hours = z.number().nonnegative();
const identifier = z.string().min(1);
const date = z.iso.date();
const time = z.iso.time({ precision: -1 });
const timestamp = z.iso.datetime({ offset: true });

// Prompt 1 deliberately uses local minute precision, without a UTC offset.
const localDeadline = z.iso.datetime({ local: true, precision: -1 })
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

export const timetableSlotSchema = z.strictObject({
  day: z.enum(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
  startTime: time,
  endTime: time,
  subject: z.string().min(1),
  type: z.enum(["Lecture", "Lab", "Tutorial"]),
  room: z.string(),
}).refine((slot) => slot.startTime < slot.endTime, {
  message: "A timetable slot must end after it starts on the same day",
  path: ["endTime"],
});

export const studentProfileSchema = z.strictObject({
  userId: identifier,
  name: z.string().min(1),
  program: z.string().min(1),
  year: z.string().min(1),
  section: z.string().min(1),
  // Absent until Classroom is connected. expiresAt is Unix epoch milliseconds.
  classroomTokens: z.strictObject({
    accessToken: identifier,
    refreshToken: identifier,
    expiresAt: z.number().int().nonnegative(),
  }).optional(),
  connectedCourses: z.array(identifier),
  timetableSlots: z.array(timetableSlotSchema),
});

export const academicEventSchema = z.strictObject({
  userId: identifier,
  eventId: z.uuid(),
  title: z.string().min(1),
  type: eventType,
  currentDeadline: z.iso.datetime({ local: true, offset: true }),
  venue: z.string().nullable(),
  estimatedHours: hours,
  status: z.enum(["ACTIVE", "CANCELLED", "DONE"]),
  sourceType: z.enum(["manual", "pdf", "classroom"]),
  sourceRef: identifier.nullable(),
  // The specified urgency formula can exceed 1 for overdue events.
  priorityScore: z.number().nonnegative(),
  changeHistory: z.array(z.string()),
});

export const classroomSyncStateSchema = z.strictObject({
  userId: identifier,
  courseId: identifier,
  lastSyncedAt: timestamp,
});

export const scheduleBlocksSchema = z.strictObject({
  userId: identifier,
  date,
  blocks: z.array(z.strictObject({
    eventId: z.uuid(),
    task: z.string().min(1),
    allocatedHours: hours,
    priority,
  })),
});

export const truthResolutionSchema = z.strictObject({
  action: z.enum(["CREATE", "UPDATE", "CANCEL", "IGNORE"]),
  targetEventId: identifier.nullable(),
  eventDetails: z.strictObject({
    title: z.string(),
    type: eventType,
    currentDeadline: localDeadline,
    venue: z.string(),
    estimatedHours: hours,
  }),
  changeSummary: z.string(),
}).superRefine((result, context) => {
  const needsTarget = result.action === "UPDATE" || result.action === "CANCEL";
  if (needsTarget === (result.targetEventId === null)) {
    context.addIssue({
      code: "custom",
      path: ["targetEventId"],
      message: needsTarget ? "UPDATE and CANCEL require a target" : "CREATE and IGNORE require a null target",
    });
  }
});

export const conflictNarrativeSchema = z.strictObject({
  collisionDetected: z.boolean(),
  collisionMessage: z.string(),
  recommendedActionPlan: z.array(z.strictObject({
    date,
    task: z.string().min(1),
    allocateHours: hours,
    priority,
  })),
});

export const timetableNormalizationSchema = z.strictObject({
  slots: z.array(timetableSlotSchema),
  lowConfidenceRows: z.array(z.string()),
});

// Accept a JSON value directly or extract the first balanced JSON object/array
// from harmless model framing such as Markdown fences. Never include raw model
// output in an error because source documents may contain private data.
function extractJSON(text) {
  if (typeof text !== "string" || !text.trim() || text.length > 250_000) {
    throw new Error("AI response is not valid JSON");
  }
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* Try balanced extraction below. */ }
  for (let start = 0; start < trimmed.length; start++) {
    if (trimmed[start] !== "{" && trimmed[start] !== "[") continue;
    const stack = [];
    let quoted = false;
    let escaped = false;
    for (let index = start; index < trimmed.length; index++) {
      const character = trimmed[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') { quoted = true; continue; }
      if (character === "{" || character === "[") stack.push(character);
      else if (character === "}" || character === "]") {
        const opening = stack.pop();
        if ((opening === "{" && character !== "}") || (opening === "[" && character !== "]")) break;
        if (!stack.length) {
          try { return JSON.parse(trimmed.slice(start, index + 1)); } catch { break; }
        }
      }
    }
  }
  throw new Error("AI response is not valid JSON");
}

export function parseAIResponse(text, schema) {
  const value = extractJSON(text);
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error("AI response does not match the expected contract");
  }
  return result.data;
}

// Kept as a compatibility export for any external test or script importing the
// old helper name. Application code uses the provider-neutral name.
export const parseBedrockResponse = parseAIResponse;
