import assert from "node:assert/strict";
import test from "node:test";
import { activeSession, cancelSession, completeSession, listTaskSessions, pauseSession, resumeSession, sessionDTO, startSession } from "../lib/focus.js";
import { completeTask, createManualTask, getTaskRecord, toTaskDTO } from "../lib/tasks.js";
import { standardTables } from "./helpers/fake-dynamo.js";

const tables = { tasks: "tasks", focus: "focus" };
const t0 = new Date("2026-09-18T12:00:00.000Z");
const at = (minutes) => new Date(t0.getTime() + minutes * 60_000);

async function setup(estimatedMinutes = 180) {
  const db = standardTables();
  const task = await createManualTask(db, "tasks", { title: "DSA Midterm Mock", estimatedMinutes }, { now: t0, timeZone: "Asia/Kolkata" });
  return { db, task };
}

test("a completed focus session adds its minutes to the task and moves progress", async () => {
  const { db, task } = await setup();
  const session = await startSession(db, tables, task.taskId, {}, t0);
  assert.equal(session.plannedMinutes, 25, "Pomodoro default");
  const result = await completeSession(db, tables, session.sessionId, {}, at(25));
  assert.equal(result.creditedMinutes, 25);
  assert.equal(result.session.status, "COMPLETED");
  assert.equal(result.session.completedMinutes, 25);
  const updated = await getTaskRecord(db, "tasks", task.taskId);
  assert.equal(updated.actualMinutes, 25);
  assert.equal(toTaskDTO(updated, { now: at(25), dailyStudyMinutes: 240 }).progress.timePercent, 14, "25 of 180 minutes");
});

test("completing the same session twice never double-counts", async () => {
  const { db, task } = await setup();
  const session = await startSession(db, tables, task.taskId, {}, t0);
  await completeSession(db, tables, session.sessionId, {}, at(25));
  const again = await completeSession(db, tables, session.sessionId, {}, at(26));
  assert.equal(again.alreadyCompleted, true);
  assert.equal(again.creditedMinutes, 0);
  assert.equal((await getTaskRecord(db, "tasks", task.taskId)).actualMinutes, 25);
});

test("paused time is not counted, and a client cannot claim more than elapsed", async () => {
  const { db, task } = await setup();
  const session = await startSession(db, tables, task.taskId, { plannedMinutes: 25 }, t0);
  await pauseSession(db, tables, session.sessionId, at(10));
  await resumeSession(db, tables, session.sessionId, at(40)); // 30 paused minutes
  assert.equal(sessionDTO(await activeSession(db, "focus"), at(45)).elapsedSeconds, 15 * 60);
  const result = await completeSession(db, tables, session.sessionId, { completedMinutes: 60 }, at(50));
  assert.equal(result.creditedMinutes, 21, "20 measured minutes plus 1 minute of skew tolerance");
  assert.equal((await getTaskRecord(db, "tasks", task.taskId)).actualMinutes, 21);
});

test("an abandoned timer is capped at the planned length by default", async () => {
  const { db, task } = await setup();
  const session = await startSession(db, tables, task.taskId, {}, t0);
  const result = await completeSession(db, tables, session.sessionId, {}, at(180));
  assert.equal(result.creditedMinutes, 25);
});

test("only one live session at a time, cancellation credits nothing, and history is kept", async () => {
  const { db, task } = await setup();
  const first = await startSession(db, tables, task.taskId, {}, t0);
  await assert.rejects(() => startSession(db, tables, task.taskId, {}, at(1)), (error) => error.code === "FOCUS_SESSION_ACTIVE");
  const cancelled = await cancelSession(db, tables, first.sessionId, at(5));
  assert.equal(cancelled.status, "CANCELLED");
  await assert.rejects(() => completeSession(db, tables, first.sessionId, {}, at(6)), (error) => error.code === "CONFLICT");
  assert.equal((await getTaskRecord(db, "tasks", task.taskId)).actualMinutes, 0);

  const second = await startSession(db, tables, task.taskId, {}, at(10));
  await completeSession(db, tables, second.sessionId, {}, at(35));
  const history = await listTaskSessions(db, "focus", task.taskId);
  assert.deepEqual(history.map((session) => session.status), ["COMPLETED", "CANCELLED"]);
  assert.equal(await activeSession(db, "focus"), null);
});

test("focus sessions only start on open tasks", async () => {
  const { db, task } = await setup();
  await completeTask(db, "tasks", task.taskId, t0);
  await assert.rejects(() => startSession(db, tables, task.taskId, {}, t0), (error) => error.code === "CONFLICT");
});
