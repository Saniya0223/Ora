import assert from "node:assert/strict";
import { createAIProvider } from "../lib/ai-providers.js";
import { resolveNotice } from "../lib/bedrock.js";
import { buildTimeline } from "../handlers/timeline.js";

const env = {
  ...process.env,
  AI_PROVIDER: "ollama",
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || "qwen3:8b",
};
const ai = createAIProvider({ env });
const now = new Date("2026-09-17T04:30:00.000Z");
const eventId = "758af182-6b93-4778-9628-13a1348bd324";
const existing = {
  userId: "demo-user",
  eventId,
  title: "DSA assignment",
  type: "Assignment",
  currentDeadline: "2026-09-20T11:30:00.000Z",
  venue: "Room 204",
  estimatedHours: 3,
  status: "ACTIVE",
  sourceType: "manual",
  sourceRef: null,
  priorityScore: 0,
  changeHistory: [],
};
const profile = { name: "Demo Student", program: "Computer Science", year: "3", section: "A" };
const checkNotice = (text, events = []) => resolveNotice({ text, sourceType: "manual", events, profile, now }, { ai });

try {
  const created = await checkNotice("New notice: Operating Systems assignment is due 21 September 2026 at 5:00 PM. Estimated work: 3 hours.");
  assert.equal(created.action, "CREATE");

  const updated = await checkNotice("The DSA assignment deadline has moved to 22 September 2026 at 5:00 PM. All other details stay the same.", [existing]);
  assert.equal(updated.action, "UPDATE");
  assert.equal(updated.targetEventId, eventId);

  const cancelled = await checkNotice("The DSA assignment has been cancelled.", [existing]);
  assert.equal(cancelled.action, "CANCEL");
  assert.equal(cancelled.targetEventId, eventId);

  const ambiguous = await checkNotice("There may be a new assignment next week, but the subject and deadline have not been confirmed.");
  assert.equal(ambiguous.action, "IGNORE");

  const db = { async send(command) {
    if (command.constructor.name === "GetCommand") return { Item: { timetableSlots: [] } };
    if (command.constructor.name === "QueryCommand") return { Items: command.input.TableName === "events" ? [existing] : [] };
    if (command.constructor.name === "BatchWriteCommand") return { UnprocessedItems: {} };
    if (command.constructor.name === "UpdateCommand") return {};
    throw new Error(`Unexpected database command: ${command.constructor.name}`);
  } };
  const plan = await buildTimeline({
    db,
    ai,
    env: { ...env, ACADEMIC_EVENTS_TABLE: "events", STUDENT_PROFILE_TABLE: "profiles", SCHEDULE_BLOCKS_TABLE: "blocks", DAILY_STUDY_HOURS: "4" },
    now: () => now,
  });
  assert.equal(plan.narrativeSource, "ollama");
  assert.ok(plan.recommendedActionPlan.length > 0);

  console.log(JSON.stringify({
    provider: ai.name,
    model: env.OLLAMA_MODEL,
    create: created.action,
    update: updated.action,
    cancel: cancelled.action,
    ambiguous: ambiguous.action,
    planner: plan.narrativeSource,
    contractsValidated: true,
  }, null, 2));
} catch (error) {
  console.error(`Ollama live check failed: ${error.message}`);
  process.exitCode = 1;
}
