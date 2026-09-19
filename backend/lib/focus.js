import { randomUUID } from "node:crypto";
import { PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { ApiError, notFound, validate } from "./api.js";
import { focusSessionRecordSchema } from "./domain.js";
import { USER_ID, getItem, putNew, queryUser } from "./store.js";
import { getTaskRecord } from "./tasks.js";

// The browser runs the live countdown. The server records only the transitions
// (start, pause, resume, complete, cancel) and measures elapsed time itself,
// so a client can never claim more focus than actually elapsed.

const sessionKey = (sessionId) => ({ userId: USER_ID, sessionId });
const parse = (row) => focusSessionRecordSchema.parse(row);
const LIVE = new Set(["ACTIVE", "PAUSED"]);

export function elapsedSeconds(session, now) {
  const running = session.runningSince ? Math.max(0, Math.floor((now.getTime() - Date.parse(session.runningSince)) / 1000)) : 0;
  return session.accumulatedSeconds + running;
}

export function sessionDTO(session, now) {
  return {
    id: session.sessionId, taskId: session.taskId, taskTitle: session.taskTitle, status: session.status,
    plannedMinutes: session.plannedMinutes, startedAt: session.startedAt, pausedAt: session.pausedAt,
    completedAt: session.completedAt, cancelledAt: session.cancelledAt, completedMinutes: session.completedMinutes,
    elapsedSeconds: LIVE.has(session.status) ? elapsedSeconds(session, now) : session.accumulatedSeconds,
    isRunning: session.status === "ACTIVE",
  };
}

async function getSession(db, tableName, sessionId) {
  if (!z.uuid().safeParse(sessionId).success) throw notFound("focus session");
  const row = await getItem(db, tableName, sessionKey(sessionId));
  if (!row) throw notFound("focus session");
  return parse(row);
}

export async function activeSession(db, tableName) {
  return (await queryUser(db, tableName)).map(parse).filter((session) => LIVE.has(session.status))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
}

export async function listTaskSessions(db, tableName, taskId) {
  return (await queryUser(db, tableName)).map(parse).filter((session) => session.taskId === taskId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function startSession(db, tables, taskId, body, now) {
  const { plannedMinutes } = validate(z.strictObject({ plannedMinutes: z.number().int().min(1).max(240).default(25) }), body);
  const task = await getTaskRecord(db, tables.tasks, taskId);
  if (task.status !== "OPEN") throw new ApiError(409, "CONFLICT", "Focus sessions can only start on an open task.");
  // One live session at a time keeps focus minutes unambiguous.
  const live = await activeSession(db, tables.focus);
  if (live) throw new ApiError(409, "FOCUS_SESSION_ACTIVE", "Finish or cancel the current focus session first.", [{ field: "sessionId", issue: live.sessionId }]);
  const at = now.toISOString();
  const session = parse({
    userId: USER_ID, sessionId: randomUUID(), version: 0, taskId, taskTitle: task.title, status: "ACTIVE",
    plannedMinutes, startedAt: at, accumulatedSeconds: 0, runningSince: at, createdAt: at, updatedAt: at,
  });
  await putNew(db, tables.focus, session, "sessionId");
  return session;
}

async function saveSession(db, tableName, previous, next) {
  try {
    await db.send(new PutCommand({
      TableName: tableName, Item: { ...next, version: previous.version + 1 },
      ConditionExpression: "#v = :v", ExpressionAttributeNames: { "#v": "version" }, ExpressionAttributeValues: { ":v": previous.version },
    }));
    return { ...next, version: previous.version + 1 };
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") throw new ApiError(409, "CONFLICT", "This focus session changed. Refresh and try again.");
    throw error;
  }
}

export async function pauseSession(db, tables, sessionId, now) {
  const session = await getSession(db, tables.focus, sessionId);
  if (session.status === "PAUSED") return session;
  if (session.status !== "ACTIVE") throw new ApiError(409, "CONFLICT", "Only a running focus session can be paused.");
  const at = now.toISOString();
  return saveSession(db, tables.focus, session, { ...session, status: "PAUSED", accumulatedSeconds: elapsedSeconds(session, now), runningSince: null, pausedAt: at, updatedAt: at });
}

export async function resumeSession(db, tables, sessionId, now) {
  const session = await getSession(db, tables.focus, sessionId);
  if (session.status === "ACTIVE") return session;
  if (session.status !== "PAUSED") throw new ApiError(409, "CONFLICT", "Only a paused focus session can be resumed.");
  const at = now.toISOString();
  return saveSession(db, tables.focus, session, { ...session, status: "ACTIVE", runningSince: at, pausedAt: null, updatedAt: at });
}

export async function cancelSession(db, tables, sessionId, now) {
  const session = await getSession(db, tables.focus, sessionId);
  if (session.status === "CANCELLED") return session;
  if (session.status === "COMPLETED") throw new ApiError(409, "CONFLICT", "A completed focus session cannot be cancelled.");
  const at = now.toISOString();
  return saveSession(db, tables.focus, session, { ...session, status: "CANCELLED", accumulatedSeconds: elapsedSeconds(session, now), runningSince: null, cancelledAt: at, updatedAt: at });
}

// Completion credits the task exactly once. The session's status change and
// the task's actualMinutes increment commit in one transaction guarded by the
// session version, so a retried or duplicated request adds nothing.
export async function completeSession(db, tables, sessionId, body, now) {
  const input = validate(z.strictObject({ completedMinutes: z.number().int().min(0).max(240).optional() }), body);
  for (let attempt = 0; attempt < 3; attempt++) {
    const session = await getSession(db, tables.focus, sessionId);
    if (session.status === "COMPLETED") return { session, alreadyCompleted: true, creditedMinutes: 0 };
    if (session.status === "CANCELLED") throw new ApiError(409, "CONFLICT", "A cancelled focus session cannot be completed.");
    const measured = Math.floor(elapsedSeconds(session, now) / 60);
    // Default credit is the measured time, capped at the planned length. A
    // client may claim a specific amount, but never more than elapsed (+1 min
    // tolerance for clock skew between browser and server).
    const credited = input.completedMinutes === undefined ? Math.min(measured, session.plannedMinutes) : Math.min(input.completedMinutes, measured + 1);
    const at = now.toISOString();
    const next = { ...session, status: "COMPLETED", accumulatedSeconds: elapsedSeconds(session, now), runningSince: null, completedAt: at, completedMinutes: credited, updatedAt: at, version: session.version + 1 };
    const taskExists = Boolean(await getItem(db, tables.tasks, { userId: USER_ID, taskId: session.taskId }));
    const items = [{
      Put: { TableName: tables.focus, Item: next, ConditionExpression: "#v = :v", ExpressionAttributeNames: { "#v": "version" }, ExpressionAttributeValues: { ":v": session.version } },
    }];
    if (taskExists && credited > 0) {
      items.push({
        Update: {
          TableName: tables.tasks, Key: { userId: USER_ID, taskId: session.taskId },
          UpdateExpression: "SET #a = if_not_exists(#a, :zero) + :m, #u = :at, #v = if_not_exists(#v, :zero) + :one",
          ConditionExpression: "attribute_exists(taskId)",
          ExpressionAttributeNames: { "#a": "actualMinutes", "#u": "updatedAt", "#v": "version" },
          ExpressionAttributeValues: { ":m": credited, ":at": at, ":zero": 0, ":one": 1 },
        },
      });
    }
    try {
      await db.send(new TransactWriteCommand({ TransactItems: items }));
      return { session: next, alreadyCompleted: false, creditedMinutes: credited };
    } catch (error) {
      // Lost a race: re-read. If another request completed it, that is final.
      if (error.name !== "TransactionCanceledException") throw error;
    }
  }
  throw new ApiError(409, "CONFLICT", "This focus session changed. Refresh and try again.");
}
