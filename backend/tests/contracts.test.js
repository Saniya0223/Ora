import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  academicEventSchema,
  classroomSyncStateSchema,
  conflictNarrativeSchema,
  parseBedrockResponse,
  scheduleBlocksSchema,
  studentProfileSchema,
  timetableNormalizationSchema,
  truthResolutionSchema,
} from "../lib/contracts.js";

const eventId = "758af182-6b93-4778-9628-13a1348bd324";
const details = {
  title: "DSA assignment",
  type: "Assignment",
  currentDeadline: "2026-09-20T23:59",
  venue: "",
  estimatedHours: 3,
};
const truth = { action: "CREATE", targetEventId: null, eventDetails: details, changeSummary: "New assignment" };
const slot = { day: "Monday", startTime: "09:00", endTime: "10:30", subject: "DSA", type: "Lecture", room: "204" };
const plan = { date: "2026-09-19", task: "Work on DSA assignment", allocateHours: 2, priority: "High" };
const narrative = { collisionDetected: false, collisionMessage: "", recommendedActionPlan: [plan] };

test("the three model contracts parse without renaming or adding fields", () => {
  for (const [schema, value] of [
    [truthResolutionSchema, truth],
    [conflictNarrativeSchema, narrative],
    [timetableNormalizationSchema, { slots: [slot], lowConfidenceRows: ["Unclear Friday row"] }],
  ]) {
    assert.deepEqual(parseBedrockResponse(JSON.stringify(value), schema), value);
  }
});

test("each action requires the correct target semantics", () => {
  for (const action of ["CREATE", "IGNORE", "UPDATE", "CANCEL"]) {
    const needsTarget = action === "UPDATE" || action === "CANCEL";
    assert.equal(truthResolutionSchema.safeParse({ ...truth, action, targetEventId: needsTarget ? eventId : null }).success, true);
    assert.equal(truthResolutionSchema.safeParse({ ...truth, action, targetEventId: needsTarget ? null : eventId }).success, false);
  }
});

test("Prompt 1 rejects impossible dates, non-minute precision, and offsets", () => {
  for (const currentDeadline of ["2026-02-29T12:00", "2026-09-31T12:00", "2026-09-20T24:00", "2026-09-20T23:59Z", "2026-09-20T23:59:00", "2026-09-20T23:59+05:30"]) {
    assert.equal(truthResolutionSchema.safeParse({ ...truth, eventDetails: { ...details, currentDeadline } }).success, false, currentDeadline);
  }
  assert.equal(truthResolutionSchema.safeParse({ ...truth, eventDetails: { ...details, currentDeadline: "2028-02-29T12:00" } }).success, true);
});

test("negative and non-finite effort cannot enter the schedule", () => {
  for (const estimatedHours of [-1, NaN, Infinity]) {
    assert.equal(truthResolutionSchema.safeParse({ ...truth, eventDetails: { ...details, estimatedHours } }).success, false);
  }
});

test("unexpected fields, unknown actions, and unknown event types are rejected", () => {
  for (const value of [
    { ...truth, action: "UPSERT" },
    { ...truth, debug: "extra" },
    { ...truth, eventDetails: { ...details, type: "Tutorial" } },
    { ...truth, eventDetails: { ...details, dueDate: details.currentDeadline } },
  ]) {
    assert.equal(truthResolutionSchema.safeParse(value).success, false);
  }
});

test("Prompt 1 does not silently relax eventDetails for IGNORE or CANCEL", () => {
  assert.equal(truthResolutionSchema.safeParse({ ...truth, action: "IGNORE", eventDetails: null }).success, false);
  assert.equal(truthResolutionSchema.safeParse({ ...truth, action: "CANCEL", targetEventId: eventId, eventDetails: null }).success, false);
});

test("narrative hours retain allocateHours; database blocks retain allocatedHours and eventId", () => {
  const { allocateHours, ...rest } = plan;
  const stored = { userId: "demo-user", date: plan.date, blocks: [{ eventId, task: plan.task, allocatedHours: allocateHours, priority: plan.priority }] };
  assert.deepEqual(scheduleBlocksSchema.parse(stored), stored);
  assert.equal(conflictNarrativeSchema.safeParse({ ...narrative, recommendedActionPlan: [{ ...rest, allocatedHours: allocateHours }] }).success, false);
  assert.equal(scheduleBlocksSchema.safeParse({ ...stored, blocks: [{ eventId, task: plan.task, allocateHours, priority: plan.priority }] }).success, false);
  assert.equal(scheduleBlocksSchema.safeParse({ ...stored, blocks: [{ task: plan.task, allocatedHours: allocateHours, priority: plan.priority }] }).success, false);
});

test("conflict narrative rejects string booleans, invalid dates, priorities, and extra IDs", () => {
  assert.equal(conflictNarrativeSchema.safeParse({ ...narrative, collisionDetected: "false" }).success, false);
  for (const change of [{ date: "2026-02-30" }, { priority: "Urgent" }, { eventId }, { allocateHours: -1 }]) {
    assert.equal(conflictNarrativeSchema.safeParse({ ...narrative, recommendedActionPlan: [{ ...plan, ...change }] }).success, false);
  }
});

test("timetable allows Tutorial but rejects invalid weekdays and time ranges", () => {
  assert.equal(timetableNormalizationSchema.safeParse({ slots: [{ ...slot, type: "Tutorial" }], lowConfidenceRows: [] }).success, true);
  for (const change of [{ day: "Mon" }, { startTime: "9:00" }, { endTime: "24:00" }, { endTime: "09:00" }, { endTime: "08:30" }]) {
    assert.equal(timetableNormalizationSchema.safeParse({ slots: [{ ...slot, ...change }], lowConfidenceRows: [] }).success, false);
  }
});

test("unconnected profiles omit tokens and keep year as a string", () => {
  const profile = { userId: "demo-user", name: "Demo Student", program: "Computer Science", year: "3", section: "A", connectedCourses: [], timetableSlots: [slot] };
  assert.deepEqual(studentProfileSchema.parse(profile), profile);
  assert.equal(studentProfileSchema.safeParse({ ...profile, year: 3 }).success, false);
  assert.equal(studentProfileSchema.safeParse({ ...profile, classroomTokens: { accessToken: "test-only", refreshToken: "test-only", expiresAt: 1790000000000 } }).success, true);
  assert.equal(studentProfileSchema.safeParse({ ...profile, classroomTokens: { accessToken: "test-only", expiresAt: 1790000000000 } }).success, false);
});

test("academic records support nullable fields and preserve the specified event vocabulary", () => {
  const event = { userId: "demo-user", eventId, ...details, venue: null, status: "ACTIVE", sourceType: "manual", sourceRef: null, priorityScore: 1.2, changeHistory: [] };
  assert.deepEqual(academicEventSchema.parse(event), event);
  assert.equal(academicEventSchema.safeParse({ ...event, currentDeadline: "2026-09-20T18:29:00Z" }).success, true);
  for (const change of [{ eventId: "not-a-uuid" }, { status: "COMPLETED" }, { sourceType: "whatsapp" }, { type: "Tutorial" }, { currentDeadline: "next Monday" }]) {
    assert.equal(academicEventSchema.safeParse({ ...event, ...change }).success, false);
  }
});

test("sync checkpoints require an unambiguous absolute timestamp", () => {
  const checkpoint = { userId: "demo-user", courseId: "course-1", lastSyncedAt: "2026-09-16T10:30:00Z" };
  assert.deepEqual(classroomSyncStateSchema.parse(checkpoint), checkpoint);
  assert.equal(classroomSyncStateSchema.safeParse({ ...checkpoint, lastSyncedAt: "2026-09-16T10:30" }).success, false);
});

test("model parsing rejects fenced or invalid JSON without leaking the source text", () => {
  const privateText = "PRIVATE_NOTICE_CONTENT";
  for (const text of [privateText, "```json\n" + JSON.stringify(truth) + "\n```", JSON.stringify({ ...truth, privateText })]) {
    assert.throws(() => parseBedrockResponse(text, truthResolutionSchema), (error) => {
      assert.equal(error.message.includes(privateText), false);
      return /Bedrock response/.test(error.message);
    });
  }
});

test("prompt files match the source-of-truth document verbatim", async () => {
  const guide = await readFile(new URL("../../docs/campusflow-implementation.md", import.meta.url), "utf8");
  const matches = [...guide.matchAll(/### Prompt [123][\s\S]*?```text\r?\n([\s\S]*?)\r?\n```/g)];
  const names = ["truth-resolution", "conflict-narrative", "timetable-normalization"];
  assert.equal(matches.length, 3);
  for (let index = 0; index < names.length; index++) {
    const prompt = await readFile(new URL(`../prompts/${names[index]}.txt`, import.meta.url), "utf8");
    assert.equal(prompt.trimEnd(), matches[index][1].trimEnd());
  }
});
