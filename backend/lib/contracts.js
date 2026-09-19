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

// Stable identity for editing one slot. Optional so slots saved before IDs
// existed, and slots returned by timetable extraction, still parse.
export const timetableSlotSchema = z.strictObject({
  id: z.uuid().optional(),
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

const clockTime = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "Use 24-hour HH:mm");

// Student planning preferences. dailyStudyHours mirrors the planner UI range.
export const planningPreferencesSchema = z.strictObject({
  dailyStudyHours: z.number().min(1).max(12).multipleOf(0.25),
  preferredStudyStart: clockTime,
  preferredStudyEnd: clockTime,
  autoScheduleStudyBlocks: z.boolean(),
  avoidClassConflicts: z.boolean(),
}).refine((value) => value.preferredStudyStart < value.preferredStudyEnd, {
  message: "The preferred study window must end after it starts on the same day",
  path: ["preferredStudyEnd"],
});

const count = z.number().int().nonnegative();

// Why items were ignored. `ignored` stays the sum, for existing readers.
// modelIgnored: the model found nothing trackable. alreadyProcessed: this exact
// source was ingested before. duplicate: an equal item already existed.
// noChange: an UPDATE carried nothing new.
export const IGNORE_REASONS = ["modelIgnored", "alreadyProcessed", "duplicate", "noChange"];
export const ignoredReasonsSchema = z.strictObject(Object.fromEntries(IGNORE_REASONS.map((reason) => [reason, count])));

export const syncResultSchema = z.strictObject({
  coursesScanned: count,
  announcementsScanned: count,
  courseworkScanned: count,
  processed: count,
  created: count,
  updated: count,
  cancelled: count,
  ignored: count,
  failed: count,
  truncated: z.boolean(),
  // Optional so sync results stored before these existed still parse.
  ignoredReasons: ignoredReasonsSchema.optional(),
  rateLimited: z.boolean().optional(),
  temporaryFailed: count.optional(),
  validationFailed: count.optional(),
  raceSkipped: count.optional(),
  needsReview: count.optional(),
  reviewItems: z.array(z.object({ courseId: identifier, sourceRef: identifier, code: identifier, sourceUrl: z.string().nullable() })).optional(),
});

export const classroomSyncStatusSchema = z.strictObject({
  status: z.enum(["SYNCING", "SUCCESS", "PARTIAL", "ERROR", "REAUTH_REQUIRED"]),
  trigger: z.enum(["scheduled", "manual"]),
  lastAttemptAt: timestamp,
  lastFinishedAt: timestamp.nullable(),
  lastSuccessfulSyncAt: timestamp.nullable(),
  lastErrorCode: z.string().nullable(),
  lastResult: syncResultSchema.nullable(),
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
  // Everything below is optional so profiles saved before these fields existed
  // keep parsing, including inside the Classroom sync, which parses strictly.
  semester: z.string().min(1).max(60).optional(),
  semesterStartDate: date.optional(),
  timezone: z.string().min(1).max(64).optional(),
  planning: planningPreferencesSchema.optional(),
  timetableSource: z.strictObject({
    kind: z.enum(["PDF", "MANUAL"]),
    fileName: z.string().max(200).nullable(),
    jobId: z.uuid().nullable(),
    importedAt: timestamp,
    updatedAt: timestamp,
  }).optional(),
  classroomAccount: z.strictObject({
    email: z.string().max(320).nullable(),
    name: z.string().max(200).nullable(),
    fetchedAt: timestamp,
  }).optional(),
  classroomSync: classroomSyncStatusSchema.optional(),
  // Epoch ms until which a sync run holds the lease; absent when idle.
  classroomSyncLease: z.number().int().nonnegative().optional(),
  // Planner bookkeeping. Loose so its internal shape can evolve without ever
  // failing the strict profile parse that the Classroom sync depends on.
  planningState: z.looseObject({}).optional(),
});

const shortText = (max) => z.string().trim().min(1).max(max);
const textList = z.array(shortText(300)).max(10);

// Structured, source-supported detail for one obligation. Every field has a
// default, so partial model output and rows stored before this existed parse.
export const eventDetailsSchema = z.strictObject({
  actionSummary: shortText(300).nullable().default(null),
  instructions: textList.default([]),
  requirements: textList.default([]),
  topics: textList.default([]),
  submissionMethod: shortText(200).nullable().default(null),
  links: z.array(z.strictObject({ label: shortText(100).nullable().default(null), url: z.url({ protocol: /^https?$/ }).max(2000) })).max(5).default([]),
  // A tentative item has no hard deadline; its possible date is kept apart.
  certainty: z.enum(["confirmed", "tentative"]).default("confirmed"),
  tentativeDeadline: z.iso.datetime({ offset: true }).nullable().default(null),
  // The source's own words for the date, e.g. "tomorrow 6 PM".
  deadlineText: shortText(120).nullable().default(null),
});

// Provenance of a source-derived item. One notice may yield several items; each
// keeps the notice identity and its position so replays never duplicate it.
export const eventSourceMetaSchema = z.strictObject({
  noticeId: z.uuid(),
  itemIndex: z.number().int().nonnegative(),
  itemCount: z.number().int().positive(),
  postedAt: timestamp.nullable(),
  updatedAt: timestamp.nullable(),
  itemKey: z.string().optional(),
  versions: z.record(z.string(), z.strictObject({ revision: z.string(), updatedAt: timestamp.nullable() })).optional(),
});

export const latestChangeSchema = z.strictObject({
  at: timestamp,
  sourceRef: z.string().nullable(),
  fields: z.array(z.strictObject({ field: z.enum(["currentDeadline", "venue", "status", "title", "instructions", "requirements", "topics", "links", "submissionMethod", "certainty"]), before: z.string().nullable(), after: z.string().nullable() })),
});

export const academicEventSchema = z.strictObject({
  userId: identifier,
  eventId: z.uuid(),
  title: z.string().min(1),
  type: eventType,
  // null when the source states no date, or only a tentative one.
  currentDeadline: z.iso.datetime({ local: true, offset: true }).nullable(),
  venue: z.string().nullable(),
  estimatedHours: hours,
  status: z.enum(["ACTIVE", "CANCELLED", "DONE"]),
  sourceType: z.enum(["manual", "pdf", "classroom"]),
  sourceRef: identifier.nullable(),
  // The specified urgency formula can exceed 1 for overdue events.
  priorityScore: z.number().nonnegative(),
  changeHistory: z.array(z.string()),
  // Optional: absent on events stored before structured details existed.
  details: eventDetailsSchema.optional(),
  sourceMeta: eventSourceMetaSchema.optional(),
  sourceUrl: z.string().nullable().optional(),
  latestChange: latestChangeSchema.nullable().optional(),
});

export const classroomSyncStateSchema = z.strictObject({
  userId: identifier,
  courseId: identifier,
  lastSyncedAt: timestamp,
  courseName: z.string().nullable().optional(),
  reviewItems: z.array(z.strictObject({ sourceRef: identifier, revision: z.string(), updatedAt: timestamp, code: identifier, sourceUrl: z.string().nullable() })).optional(),
  processedItems: z.array(z.strictObject({ sourceRef: identifier, revision: z.string() })).optional(),
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

const truthEventDetails = z.strictObject({
  title: z.string(),
  type: eventType,
  currentDeadline: localDeadline,
  // A missing venue is legitimately null, which academicEventSchema already
  // stores; models differ on whether they answer "" or null for "no venue".
  venue: z.string().nullable(),
  estimatedHours: hours,
});

// An IGNORE decision describes no event, so it has no honest deadline to state.
// The acting branches still require a complete object; IGNORE may answer with {}
// or omit the field, and ingestion discards eventDetails on IGNORE regardless.
// Agreed as the explicit resolution to the open question in phase-1-decisions.
export const truthResolutionSchema = z.strictObject({
  action: z.enum(["CREATE", "UPDATE", "CANCEL", "IGNORE"]),
  targetEventId: identifier.nullable(),
  eventDetails: z.union([truthEventDetails, z.strictObject({}), z.null()]).optional(),
  changeSummary: z.string(),
}).superRefine((result, context) => {
  if (result.action !== "IGNORE" && !truthEventDetails.safeParse(result.eventDetails).success) {
    context.addIssue({
      code: "custom",
      path: ["eventDetails"],
      message: "CREATE, UPDATE, and CANCEL require complete event details",
    });
  }
  const needsTarget = result.action === "UPDATE" || result.action === "CANCEL";
  if (needsTarget === (result.targetEventId === null)) {
    context.addIssue({
      code: "custom",
      path: ["targetEventId"],
      message: needsTarget ? "UPDATE and CANCEL require a target" : "CREATE and IGNORE require a null target",
    });
  }
});

// Truth Resolution v2: one notice resolves to 0..N items. The shape is lenient
// (unknown keys are dropped, lengths are capped later) so a harmless model
// quirk never costs a second call; the semantics stay strict. Ingestion
// sanitizes every value before anything is stored.
export const MODEL_IGNORE_REASONS = ["no_student_action", "not_applicable", "no_new_information", "informational", "uncertain"];
const looseText = z.string().nullable().default(null);
const looseList = z.array(z.string()).default([]);
const batchDetails = z.object({
  title: z.string().trim().min(1),
  type: eventType,
  currentDeadline: localDeadline.nullable().default(null),
  deadlineText: looseText,
  certainty: z.enum(["confirmed", "tentative"]).default("confirmed"),
  venue: looseText,
  estimatedHours: hours.default(0),
  actionSummary: looseText,
  instructions: looseList,
  requirements: looseList,
  topics: looseList,
  submissionMethod: looseText,
  links: z.array(z.object({ label: looseText, url: z.string() })).default([]),
});
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
// v2 answers put the detail fields directly on each result: GPT-OSS 20B at low
// reasoning effort reliably mis-closes a nested details object. Nested
// `eventDetails` (v1 and early v2) is still accepted.
const unflatten = (value) => {
  if (!isRecord(value) || "eventDetails" in value || !("title" in value)) return value;
  const { action, targetEventId, changeSummary, ...eventDetails } = value;
  return { action, targetEventId, changeSummary, eventDetails };
};
const batchItem = z.preprocess(unflatten, z.object({
  action: z.enum(["CREATE", "UPDATE", "CANCEL", "IGNORE"]),
  targetEventId: identifier.nullable().default(null),
  // Validated per action below: CANCEL and IGNORE may carry anything or nothing.
  eventDetails: z.unknown().optional(),
  changeSummary: z.string().default(""),
})).superRefine((item, context) => {
  // CANCEL reads nothing but its target, so it may omit details.
  if ((item.action === "CREATE" || item.action === "UPDATE") && !batchDetails.safeParse(item.eventDetails).success) {
    context.addIssue({ code: "custom", path: ["eventDetails"], message: "CREATE and UPDATE require event details" });
  }
  const needsTarget = item.action === "UPDATE" || item.action === "CANCEL";
  if (needsTarget && item.targetEventId === null) {
    context.addIssue({ code: "custom", path: ["targetEventId"], message: "UPDATE and CANCEL require a target" });
  }
  if (item.action === "CREATE" && item.targetEventId !== null) {
    context.addIssue({ code: "custom", path: ["targetEventId"], message: "CREATE requires a null target" });
  }
});
const ignoreReason = (value) => (MODEL_IGNORE_REASONS.includes(value) ? value : "unspecified");

// Accepts the v2 `{ results, ignoreReason }` shape and the original
// single-result shape, and normalizes both to `{ results, ignoreReason }`.
// IGNORE entries are dropped: an empty result list is how a notice is ignored.
// A stray non-object entry (a mis-closed key) is dropped when complete items
// survive it. If nothing would survive, the answer is invalid: a broken answer
// is never read as "nothing to track".
const resultList = z.array(z.unknown()).max(10).transform((entries, context) => {
  const records = entries.filter(isRecord);
  if (entries.length && !records.length) context.addIssue({ code: "custom", message: "results contains no result objects" });
  return records;
}).pipe(z.array(batchItem));

export const truthResolutionBatchSchema = z.union([
  z.object({ results: resultList, ignoreReason: z.string().nullable().optional() }),
  batchItem,
]).transform((value) => {
  const items = "results" in value ? value.results : [value];
  const results = items.filter((item) => item.action !== "IGNORE").map((item) => ({
    ...item,
    targetEventId: item.action === "CREATE" ? null : item.targetEventId,
    eventDetails: item.action === "CANCEL" ? null : batchDetails.parse(item.eventDetails),
  }));
  return { results, ignoreReason: results.length ? null : ignoreReason(value.ignoreReason ?? null) };
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
