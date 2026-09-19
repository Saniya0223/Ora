import { db, bedrock, s3 } from "../lib/clients.js";
import { ApiError, errorResponse, json, query, readBody, validate } from "../lib/api.js";
import { attachmentDownload, confirmAttachment, deleteAttachment, deleteTaskFiles, requestAttachmentUpload } from "../lib/attachments.js";
import { buildDashboard } from "../lib/dashboard.js";
import { estimateTaskEffort } from "../lib/enrichment.js";
import { activeSession, cancelSession, completeSession, listTaskSessions, pauseSession, resumeSession, sessionDTO, startSession } from "../lib/focus.js";
import { IngestionError } from "../lib/errors.js";
import { createManualBlock, deleteManualBlock, ensurePlanFresh, plannerRange, rangeSchema, removeFutureTaskBlocks, replan, toICS } from "../lib/planner.js";
import { sourcesDTO } from "../lib/sources.js";
import { requireTables, USER_ID, deleteItem } from "../lib/store.js";
import { loadProfile, preferencesDTO, profilePreferences, profileTimeZone, requireProfile, savePreferences } from "../lib/student-profile.js";
import {
  addChecklistItem, completeTask, createManualTask, deleteChecklistItem, filterTasks, getTaskRecord, listQuerySchema,
  mutateTask, reconcileTasks, reopenTask, reorderChecklist, toTaskDTO, updateChecklistItem, updateTask,
} from "../lib/tasks.js";
import { isAIConfigured } from "../lib/ai-providers.js";
import { z } from "zod";

const ID = "([0-9a-f-]{36})";
const ANY_ID = "([A-Za-z0-9-]{1,64})";

// Every route: [method, path pattern, required tables, handler(context, ...params)].
const routes = [
  ["GET", "/dashboard", ["profile", "tasks", "events", "blocks"], async (c) => json(200, await buildDashboard(c.deps, c.now))],

  ["GET", "/tasks", ["profile", "tasks", "events"], async (c) => {
    const filters = validate(listQuerySchema, query(c.request), "Some filters are invalid.");
    const [tasks, profile] = await Promise.all([reconcileTasks(c.db, c.tables, c.now), loadProfile(c.db, c.tables.profile)]);
    const dtos = tasks.map((task) => toTaskDTO(task, c.taskContext(profile)));
    return json(200, filterTasks(dtos, filters, c.now, profileTimeZone(profile)));
  }],
  ["POST", "/tasks", ["profile", "tasks"], async (c) => {
    const profile = await loadProfile(c.db, c.tables.profile);
    const task = await createManualTask(c.db, c.tables.tasks, c.body(), { now: c.now, timeZone: profileTimeZone(profile) });
    return json(201, { task: toTaskDTO(task, c.taskContext(profile), { detail: true }) });
  }],
  ["GET", `/tasks/${ID}`, ["profile", "tasks"], async (c, id) => c.taskResponse(200, await getTaskRecord(c.db, c.tables.tasks, id))],
  ["PATCH", `/tasks/${ID}`, ["profile", "tasks"], async (c, id) => {
    const profile = await loadProfile(c.db, c.tables.profile);
    return c.taskResponse(200, await updateTask(c.db, c.tables.tasks, id, c.body(), { now: c.now, timeZone: profileTimeZone(profile) }), profile);
  }],
  ["DELETE", `/tasks/${ID}`, ["tasks", "blocks"], async (c, id) => {
    const task = await getTaskRecord(c.db, c.tables.tasks, id);
    if (task.academicEventId) throw new ApiError(409, "SOURCE_MANAGED", "Tasks from a connected source cannot be deleted. Complete it instead, or it is cancelled when the source cancels it.");
    await removeFutureTaskBlocks(c.db, c.tables.blocks, id, c.now);
    if (c.deps.bucket) await deleteTaskFiles(c.deps, task);
    await deleteItem(c.db, c.tables.tasks, { userId: USER_ID, taskId: id });
    return json(200, { deleted: true, id });
  }],
  ["POST", `/tasks/${ID}/complete`, ["profile", "tasks", "blocks"], async (c, id) => {
    const task = await completeTask(c.db, c.tables.tasks, id, c.now);
    await removeFutureTaskBlocks(c.db, c.tables.blocks, id, c.now);
    return c.taskResponse(200, task);
  }],
  ["POST", `/tasks/${ID}/reopen`, ["profile", "tasks"], async (c, id) => c.taskResponse(200, await reopenTask(c.db, c.tables.tasks, id, c.now))],
  ["PUT", `/tasks/${ID}/bookmark`, ["profile", "tasks"], async (c, id) => {
    const { bookmarked } = validate(z.strictObject({ bookmarked: z.boolean() }), c.body());
    return c.taskResponse(200, await mutateTask(c.db, c.tables.tasks, id, c.now, (task) => (task.bookmarked === bookmarked ? null : Object.assign(task, { bookmarked }))));
  }],
  ["PUT", `/tasks/${ID}/notes`, ["profile", "tasks"], async (c, id) => {
    const { notes } = validate(z.strictObject({ notes: z.string().max(20_000) }), c.body());
    return c.taskResponse(200, await mutateTask(c.db, c.tables.tasks, id, c.now, (task) => Object.assign(task, { notes })));
  }],
  ["POST", `/tasks/${ID}/checklist`, ["profile", "tasks"], async (c, id) => {
    const { task, item } = await addChecklistItem(c.db, c.tables.tasks, id, c.body(), c.now);
    return json(201, { item, task: c.taskDTO(task) });
  }],
  ["PUT", `/tasks/${ID}/checklist/order`, ["profile", "tasks"], async (c, id) => c.taskResponse(200, await reorderChecklist(c.db, c.tables.tasks, id, c.body(), c.now))],
  ["PATCH", `/tasks/${ID}/checklist/${ID}`, ["profile", "tasks"], async (c, id, itemId) => c.taskResponse(200, await updateChecklistItem(c.db, c.tables.tasks, id, itemId, c.body(), c.now))],
  ["DELETE", `/tasks/${ID}/checklist/${ID}`, ["profile", "tasks"], async (c, id, itemId) => c.taskResponse(200, await deleteChecklistItem(c.db, c.tables.tasks, id, itemId, c.now))],
  ["POST", `/tasks/${ID}/estimate`, ["profile", "tasks"], async (c, id) => {
    if (!isAIConfigured(c.env)) throw new ApiError(503, "NOT_CONFIGURED", "Effort estimation is not connected yet.");
    return c.taskResponse(200, await estimateTaskEffort(c.deps, c.tables.tasks, id, c.now));
  }],

  ["GET", `/tasks/${ID}/attachments`, ["tasks"], async (c, id) => json(200, { attachments: (await getTaskRecord(c.db, c.tables.tasks, id)).attachments.map(({ s3Key, ...rest }) => rest) })],
  ["POST", `/tasks/${ID}/attachments`, ["tasks"], async (c, id) => json(201, await requestAttachmentUpload(c.requireBucket(), id, c.body(), c.now))],
  ["POST", `/tasks/${ID}/attachments/${ID}/confirm`, ["tasks"], async (c, id, attachmentId) => json(200, { attachment: await confirmAttachment(c.requireBucket(), id, attachmentId, c.now) })],
  ["GET", `/tasks/${ID}/attachments/${ID}/download`, ["tasks"], async (c, id, attachmentId) => json(200, await attachmentDownload(c.requireBucket(), id, attachmentId))],
  ["DELETE", `/tasks/${ID}/attachments/${ID}`, ["tasks"], async (c, id, attachmentId) => {
    await deleteAttachment(c.requireBucket(), id, attachmentId, c.now);
    return json(200, { deleted: true, id: attachmentId });
  }],

  ["GET", `/tasks/${ID}/focus-sessions`, ["tasks", "focus"], async (c, id) => {
    await getTaskRecord(c.db, c.tables.tasks, id);
    return json(200, { sessions: (await listTaskSessions(c.db, c.tables.focus, id)).map((session) => sessionDTO(session, c.now)) });
  }],
  ["POST", `/tasks/${ID}/focus-sessions`, ["tasks", "focus"], async (c, id) => json(201, { session: sessionDTO(await startSession(c.db, c.tables, id, c.body(), c.now), c.now) })],
  ["GET", "/focus-sessions/active", ["focus"], async (c) => {
    const session = await activeSession(c.db, c.tables.focus);
    return json(200, { session: session ? sessionDTO(session, c.now) : null });
  }],
  ["POST", `/focus-sessions/${ID}/pause`, ["focus"], async (c, id) => json(200, { session: sessionDTO(await pauseSession(c.db, c.tables, id, c.now), c.now) })],
  ["POST", `/focus-sessions/${ID}/resume`, ["focus"], async (c, id) => json(200, { session: sessionDTO(await resumeSession(c.db, c.tables, id, c.now), c.now) })],
  ["POST", `/focus-sessions/${ID}/cancel`, ["focus"], async (c, id) => json(200, { session: sessionDTO(await cancelSession(c.db, c.tables, id, c.now), c.now) })],
  ["POST", `/focus-sessions/${ID}/complete`, ["profile", "tasks", "focus"], async (c, id) => {
    const result = await completeSession(c.db, c.tables, id, c.body(), c.now);
    const task = await getTaskRecord(c.db, c.tables.tasks, result.session.taskId).catch(() => null);
    return json(200, { session: sessionDTO(result.session, c.now), alreadyCompleted: result.alreadyCompleted, creditedMinutes: result.creditedMinutes, task: task ? await c.taskDTOWithProfile(task) : null });
  }],

  ["GET", "/preferences", ["profile"], async (c) => json(200, { preferences: preferencesDTO(requireProfile(await loadProfile(c.db, c.tables.profile)), c.env) })],
  ["PUT", "/preferences", ["profile"], async (c) => {
    const body = c.body();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "VALIDATION_ERROR", "Send the preferences as a JSON object.");
    const allowed = ["dailyStudyHours", "preferredStudyStart", "preferredStudyEnd", "autoScheduleStudyBlocks", "avoidClassConflicts", "timezone"];
    const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
    if (unknown.length) throw new ApiError(400, "VALIDATION_ERROR", "Some fields are invalid.", unknown.map((field) => ({ field, issue: "Unknown field" })));
    return json(200, { preferences: await savePreferences(c.db, c.tables.profile, body, c.env) });
  }],

  ["GET", "/planner", ["profile", "tasks", "events", "blocks"], async (c) => {
    const range = validate(rangeSchema, query(c.request), "Provide from and to as YYYY-MM-DD, at most 42 days apart.");
    const context = await ensurePlanFresh(c.deps, c.now);
    return json(200, await plannerRange(c.deps, range, c.now, context));
  }],
  ["GET", "/planner/export", ["profile", "tasks", "events", "blocks"], async (c) => {
    const range = validate(rangeSchema, query(c.request), "Provide from and to as YYYY-MM-DD, at most 42 days apart.");
    const context = await ensurePlanFresh(c.deps, c.now);
    const body = toICS(await plannerRange(c.deps, range, c.now, context), c.now);
    return { statusCode: 200, headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": `attachment; filename="campusflow-${range.from}-to-${range.to}.ics"`, "cache-control": "no-store" }, body };
  }],
  ["POST", "/schedule/replan", ["profile", "tasks", "events", "blocks"], async (c) => {
    // An explicit replan always generates blocks, even when automatic
    // scheduling is off: the student asked for a plan.
    const result = await replan(c.deps, { now: c.now, generate: true });
    return json(200, { plannedAt: result.plannedAt, removed: result.removed, blocks: result.blocks.map((block) => ({ id: block.blockId, taskId: block.taskId, type: block.type, title: block.title, start: block.start, end: block.end, generated: true, status: "PLANNED", isPast: false, outsidePreferredWindow: block.outsidePreferredWindow, location: null })), capacity: result.capacity });
  }],
  ["POST", "/schedule/blocks", ["blocks"], async (c) => {
    const block = await createManualBlock(c.db, c.tables.blocks, c.body(), c.now);
    return json(201, { block: { id: block.blockId, taskId: block.taskId, type: block.type, title: block.title, start: block.start, end: block.end, generated: false, status: block.status, isPast: Date.parse(block.end) <= c.now.getTime(), outsidePreferredWindow: false, location: block.location } });
  }],
  ["DELETE", `/schedule/blocks/${ANY_ID}`, ["blocks"], async (c, blockId) => {
    await deleteManualBlock(c.db, c.tables.blocks, blockId);
    return json(200, { deleted: true, id: blockId });
  }],

  ["GET", "/sources", ["profile"], async (c) => json(200, await sourcesDTO(c.db, c.tables, await loadProfile(c.db, c.tables.profile), c.now))],
];

const compiled = routes.map(([method, pattern, needs, run]) => ({ method, regex: new RegExp(`^${pattern}$`), needs, run }));

export async function handleStudent(request, dependencies) {
  const env = dependencies.env ?? process.env;
  const method = request.requestContext?.http?.method;
  const path = (request.rawPath ?? "").replace(/\/+$/, "") || "/";
  try {
    if (method === "OPTIONS") return { statusCode: 204, headers: { "cache-control": "no-store" }, body: "" };
    const matches = compiled.map((route) => ({ route, match: route.regex.exec(path) })).filter(({ match }) => match);
    if (!matches.length) throw new ApiError(404, "NOT_FOUND", "This endpoint does not exist.");
    const found = matches.find(({ route }) => route.method === method);
    if (!found) throw new ApiError(405, "METHOD_NOT_ALLOWED", "This method is not supported here.");
    const tables = requireTables(env, ...found.route.needs);
    const now = dependencies.now?.() ?? new Date();
    const deps = { ...dependencies, env, tables, bucket: env.UPLOAD_BUCKET };
    let parsedBody;
    let profileCache;
    const profileOnce = async () => (profileCache ??= await loadProfile(dependencies.db, tables.profile));
    const taskContext = (profile) => ({ now, dailyStudyMinutes: profilePreferences(profile, env).dailyStudyHours * 60 });
    const context = {
      request, env, now, tables, deps, db: dependencies.db,
      body: () => (parsedBody ??= readBody(request)),
      taskContext,
      taskDTO: (task, profile) => toTaskDTO(task, taskContext(profile ?? profileCache ?? null), { detail: true }),
      taskDTOWithProfile: async (task) => toTaskDTO(task, taskContext(await profileOnce()), { detail: true }),
      taskResponse: async (status, task, profile) => json(status, { task: toTaskDTO(task, taskContext(profile ?? await profileOnce()), { detail: true }) }),
      requireBucket: () => {
        if (!env.UPLOAD_BUCKET) throw new ApiError(503, "NOT_CONFIGURED", "File storage is not connected yet.");
        return deps;
      },
    };
    return await found.route.run(context, ...found.match.slice(1));
  } catch (error) {
    if (error instanceof IngestionError) return errorResponse(error);
    if (error?.name === "ConditionalCheckFailedException" && /\/preferences$/.test(path)) return errorResponse(new ApiError(409, "PROFILE_REQUIRED", "Save your student profile first."));
    // Never log request bodies, notes, model output, or SDK error messages.
    console.error(JSON.stringify({ code: "STUDENT_API_ERROR", route: `${method} ${path.replace(/[0-9a-f-]{36}/g, ":id")}`, reason: error?.name ?? "UNKNOWN", requestId: request.requestContext?.requestId }));
    return json(503, { error: { code: "SERVICE_UNAVAILABLE", message: "CampusFlow is temporarily unavailable. Please try again." } });
  }
}

export const handler = (request) => handleStudent(request, { db, bedrock, s3 });
