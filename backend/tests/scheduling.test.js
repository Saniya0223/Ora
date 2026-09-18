import assert from "node:assert/strict";
import test from "node:test";
import { allocateWork, detectCollisions, expandTimetable, scoreEvents } from "../lib/scheduling.js";
import { buildTimeline } from "../handlers/timeline.js";

const now = new Date("2026-09-17T04:30:00Z");
const event = (changes = {}) => ({ userId: "demo-user", eventId: "758af182-6b93-4778-9628-13a1348bd324", title: "DSA exam", type: "Exam", currentDeadline: "2026-09-18T12:00:00Z", estimatedHours: 4, venue: null, status: "ACTIVE", sourceType: "manual", sourceRef: null, priorityScore: 0, changeHistory: [], ...changes });

test("scoring uses the exact formula and excludes closed events", () => {
  const values = scoreEvents([event(), event({ status: "DONE" }), event({ status: "CANCELLED" })], now);
  assert.equal(values.length, 1);
  assert.equal(values[0].priorityScore, (1 - 31.5 / 336) * 0.5 + (4 / 6) * 0.3 + 0.2);
  assert.ok(scoreEvents([event({ currentDeadline: "2026-08-01T12:00:00Z" })], now)[0].priorityScore > 1);
});

test("collision windows include exactly 48 hours and require more than six hours", () => {
  const first = event({ estimatedHours: 3 });
  const second = event({ eventId: "a38c2587-e4d1-44df-bbad-bfd4f1ecce9d", currentDeadline: "2026-09-20T12:00:00Z", estimatedHours: 3 });
  assert.equal(detectCollisions([first, second]).length, 0);
  assert.equal(detectCollisions([first, { ...second, estimatedHours: 3.1 }]).length, 1);
  assert.equal(detectCollisions([first, { ...second, currentDeadline: "2026-09-20T12:00:01Z", estimatedHours: 4 }]).length, 0);
});

test("timetable expansion handles campus midnight and a month boundary", () => {
  const rows = expandTimetable([{ day: "Thursday", startTime: "09:00", endTime: "11:00", subject: "DSA", type: "Lecture", room: "204" }], new Date("2026-09-30T20:00:00Z"));
  assert.equal(rows[0].date, "2026-10-01");
  assert.equal(rows[0].classes.length, 1);
  assert.equal(rows[6].date, "2026-10-07");
});

test("allocation respects now, class overlaps, deadlines, daily capacity, and effort totals", () => {
  const rows = expandTimetable([
    { day: "Thursday", startTime: "10:00", endTime: "12:00", subject: "A", type: "Lecture", room: "1" },
    { day: "Thursday", startTime: "11:00", endTime: "13:00", subject: "B", type: "Lab", room: "2" },
  ], now);
  const scored = scoreEvents([event({ estimatedHours: 5, currentDeadline: "2026-09-17T09:30:00Z" })], now); // 15:00 IST
  const result = allocateWork(scored, rows, now, 4);
  assert.equal(result.days[0].blocks[0].allocatedHours, 2); // free 13:00–15:00
  assert.equal(result.unallocated[0].remainingHours, 3);
  assert.equal(result.days.slice(1).flatMap((day) => day.blocks).length, 0);
});

test("seven-day allocation reports overflow instead of inventing available hours", () => {
  const result = allocateWork(scoreEvents([event({ estimatedHours: 40, currentDeadline: "2026-10-01T12:00:00Z" })], now), expandTimetable([], now), now, 4);
  assert.equal(result.days.reduce((sum, day) => sum + day.blocks.reduce((total, block) => total + block.allocatedHours, 0), 0), 28);
  assert.equal(result.unallocated[0].remainingHours, 12);
});

test("invalid Bedrock narration falls back to code and only code-owned blocks are stored", async () => {
  const writes = [];
  const db = { async send(command) {
    if (command.constructor.name === "GetCommand") return {};
    if (command.constructor.name === "QueryCommand") return { Items: command.input.TableName === "events" ? [event()] : [{ userId: "demo-user", date: "2026-09-01", blocks: [] }] };
    if (command.constructor.name === "BatchWriteCommand") writes.push(...command.input.RequestItems.blocks);
    return {};
  } };
  const bedrock = { async send() { return { stopReason: "end_turn", output: { message: { content: [{ text: JSON.stringify({ collisionDetected: true, collisionMessage: "Wrong", recommendedActionPlan: [] }) }] } } }; } };
  const result = await buildTimeline({ db, bedrock, env: { ACADEMIC_EVENTS_TABLE: "events", STUDENT_PROFILE_TABLE: "profiles", SCHEDULE_BLOCKS_TABLE: "blocks", BEDROCK_MODEL_ID: "mock" }, now: () => now });
  assert.equal(result.narrativeSource, "deterministic");
  assert.equal(result.collisionDetected, false);
  assert.equal(result.days.flatMap((day) => day.blocks)[0].eventId, event().eventId);
  assert.equal(writes.filter((write) => write.PutRequest).length, 7);
  assert.equal(writes.filter((write) => write.DeleteRequest).length, 1);
});
