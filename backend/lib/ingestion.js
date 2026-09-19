import { createHash } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { academicEventSchema, eventDetailsSchema, studentProfileSchema } from "./contracts.js";
import { resolveNotice } from "./bedrock.js";
import { IngestionError } from "./errors.js";
import { resolveDeadlineText } from "./relative-date.js";
import { syncTaskForEvent } from "./tasks.js";
import { deadlineInstant } from "./time.js";
import { DEFAULT_TIME_ZONE, daysBetween, isValidTimeZone, localParts, weekdayOf, zonedInstant } from "./zone.js";

export const DEMO_USER_ID = "demo-user";
export const noticeTextSchema = z.string().trim().min(1).max(12_000);
const timestamp = z.iso.datetime({ offset: true });
const noticeSchema = z.strictObject({
  text: noticeTextSchema,
  sourceType: z.enum(["manual", "pdf", "classroom"]),
  sourceRef: z.string().min(1).nullable(),
  // When the source was posted and last edited. Relative dates in the text
  // ("tomorrow 6 PM") mean the day after posting, not after processing.
  postedAt: timestamp.nullable().optional(),
  updatedAt: timestamp.nullable().optional(),
});
const applicabilitySchema = studentProfileSchema.pick({ name: true, program: true, year: true, section: true, timezone: true });
const normalise = (value) => (value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
const comparable = (value) => normalise(value).replace(/[^\p{L}\p{N}:]+/gu, " ").trim();
const DAY_MS = 24 * 60 * 60 * 1000;
// Undated items stay comparable for a while so reminders and changes still
// match them, without the prompt growing forever.
const UNDATED_WINDOW_MS = 45 * DAY_MS;
const silent = () => {};
const defaultLog = process.env.NODE_TEST_CONTEXT ? silent : (entry) => console.log(JSON.stringify(entry));

function uuid5(parts) {
  const namespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const bytes = createHash("sha1").update(namespace).update(JSON.stringify(parts)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// UUID v5: the same source notice gets the same CREATE key, including on a
// retry after a lost response. The DynamoDB schema still contains only a UUID.
export function noticeEventId({ text, sourceType, sourceRef }) {
  return uuid5(["campusflow", DEMO_USER_ID, sourceType, sourceRef, text.trim().replace(/\r\n?/g, "\n")]);
}

// The nth item a notice creates. The first keeps the notice's own ID, so every
// event ingested before multi-item notices existed is still recognised.
export function itemEventId(noticeId, index) {
  return index === 0 ? noticeId : uuid5(["campusflow-item", noticeId, index]);
}

export async function queryEvents({ db, tableName }) {
  const events = [];
  let cursor;
  do {
    const page = await db.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: { ":userId": DEMO_USER_ID },
      ConsistentRead: true,
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }));
    for (const item of page.Items ?? []) {
      const event = academicEventSchema.parse(item);
      if (event.userId !== DEMO_USER_ID) throw new Error("Unexpected event owner");
      events.push(event);
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return events;
}

// ---------------------------------------------------------------------------
// Sanitizing model output
// ---------------------------------------------------------------------------

const clean = (value, max) => {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
};
const cleanList = (values) => [...new Set((values ?? []).map((value) => clean(value, 300)).filter(Boolean))].slice(0, 10);
const VAGUE = /^(please )?(complete|do|finish) (the |this )?(required |given |assigned )?(task|work|activity)s?\.?$|^(follow|see|check) (the )?(given |above )?instructions\.?$|^academic (activity|task|event)\.?$|^(do )?as (mentioned|instructed|stated)\.?$|^(n\/?a|none|null)\.?$/i;
const specific = (value, max) => {
  const text = clean(value, max);
  return text && !VAGUE.test(text) ? text : null;
};

// Links are kept only when they literally appear in the source: a model can
// shorten or drop a link, but it can never introduce one.
const URL_PATTERN = /https?:\/\/[^\s"'<>`]+/gi;
const trimUrl = (url) => url.replace(/[)\].,;:!?'"]+$/, "");
export function sourceLinks(text) {
  return [...new Set((text.match(URL_PATTERN) ?? []).map(trimUrl))].filter((url) => {
    try { return ["http:", "https:"].includes(new URL(url).protocol) && url.length <= 2000; } catch { return false; }
  });
}
function cleanLinks(links, allowed) {
  const kept = new Map();
  for (const link of links ?? []) {
    const url = typeof link?.url === "string" ? trimUrl(link.url.trim()) : "";
    if (allowed.includes(url) && !kept.has(url)) kept.set(url, { label: clean(link.label, 100), url });
  }
  return [...kept.values()].slice(0, 5);
}

// A deadline is resolved in code whenever the source's own words are a phrase
// the resolver understands, anchored to when the source was posted. The model's
// value is used only for what code cannot read, such as an absolute date.
// Weekday names are the one exception: the rest of the notice can move them
// ("moved from Friday to Monday" means the Monday after that Friday), which
// only the model sees. So a weekday answer from the model is kept when it
// falls on that weekday within two weeks of posting, and replaced otherwise.
function resolveDeadline(details, { text, anchorMs, timeZone }) {
  const expression = clean(details.deadlineText, 120);
  const inSource = Boolean(expression) && comparable(text).includes(comparable(expression));
  const resolved = inSource ? resolveDeadlineText(expression, anchorMs, timeZone) : null;
  const model = details.currentDeadline;
  const modelFits = Boolean(resolved?.kind === "weekday" && model) && (() => {
    const offset = daysBetween(localParts(anchorMs, timeZone).date, model.slice(0, 10));
    return weekdayOf(model.slice(0, 10)) === weekdayOf(resolved.date) && offset >= 0 && offset <= 13;
  })();
  const chosen = resolved && !modelFits ? `${resolved.date}T${resolved.time}` : model;
  return {
    instant: chosen ? zonedInstant(chosen.slice(0, 10), chosen.slice(11, 16), timeZone) : null,
    deadlineText: inSource ? expression : null,
    disagreed: Boolean(resolved && model && chosen !== model),
  };
}

function normaliseItem(eventDetails, context) {
  const { instant, deadlineText, disagreed } = resolveDeadline(eventDetails, context);
  const tentative = eventDetails.certainty === "tentative";
  const at = instant === null ? null : new Date(instant).toISOString();
  const links = cleanLinks(eventDetails.links, context.links);
  return {
    title: clean(eventDetails.title, 300),
    type: eventDetails.type,
    // A tentative date is never a hard deadline; it is kept beside it instead.
    currentDeadline: tentative ? null : at,
    venue: clean(eventDetails.venue, 200),
    estimatedHours: eventDetails.estimatedHours,
    details: eventDetailsSchema.parse({
      actionSummary: specific(eventDetails.actionSummary, 300),
      instructions: cleanList(eventDetails.instructions).filter((value) => !VAGUE.test(value)),
      requirements: cleanList(eventDetails.requirements),
      topics: cleanList(eventDetails.topics),
      submissionMethod: clean(eventDetails.submissionMethod, 200),
      // With a single item, every link in the source belongs to it.
      links: links.length || !context.single ? links : context.links.slice(0, 5).map((url) => ({ label: null, url })),
      certainty: tentative ? "tentative" : "confirmed",
      tentativeDeadline: tentative ? at : null,
      deadlineText,
    }),
    disagreed,
  };
}

// ---------------------------------------------------------------------------
// Comparing items
// ---------------------------------------------------------------------------

const instantOf = (value) => (value ? deadlineInstant(value) : null);
const detailsOf = (event) => eventDetailsSchema.parse(event.details ?? {});
// deadlineText (the source's wording of a date) and actionSummary (the model's
// one-line paraphrase) are not facts about the item: a reminder that only
// rewords them is not a change.
const substance = (event) => {
  const { deadlineText, actionSummary, ...rest } = detailsOf(event);
  return JSON.stringify(rest);
};

function sameDetails(event, next) {
  return normalise(event.title) === normalise(next.title)
    && event.type === next.type
    && instantOf(event.currentDeadline) === instantOf(next.currentDeadline)
    && normalise(event.venue) === normalise(next.venue)
    && event.estimatedHours === next.estimatedHours
    && substance(event) === substance(next);
}

// The same obligation announced again: same name, kind, and deadline.
const sameObligation = (event, next) => event.status === "ACTIVE"
  && normalise(event.title) === normalise(next.title)
  && event.type === next.type
  && instantOf(event.currentDeadline) === instantOf(next.currentDeadline);

// An UPDATE keeps whatever the new source does not restate.
function mergeUpdate(target, next) {
  const before = detailsOf(target);
  const after = next.details;
  const tentative = after.certainty === "tentative";
  const links = new Map([...after.links, ...before.links].map((link) => [link.url, link]));
  const details = eventDetailsSchema.parse({
    actionSummary: after.actionSummary ?? before.actionSummary,
    instructions: after.instructions.length ? after.instructions : before.instructions,
    requirements: after.requirements.length ? after.requirements : before.requirements,
    topics: after.topics.length ? after.topics : before.topics,
    submissionMethod: after.submissionMethod ?? before.submissionMethod,
    links: [...links.values()].slice(0, 5),
    certainty: after.certainty,
    tentativeDeadline: tentative ? after.tentativeDeadline ?? before.tentativeDeadline ?? target.currentDeadline : null,
    deadlineText: after.deadlineText ?? before.deadlineText,
  });
  return {
    title: next.title,
    type: next.type,
    // A confirmation without a restated date keeps the date already known.
    currentDeadline: tentative ? null : next.currentDeadline ?? target.currentDeadline ?? before.tentativeDeadline,
    venue: next.venue ?? target.venue,
    estimatedHours: next.estimatedHours > 0 ? next.estimatedHours : target.estimatedHours,
    details,
  };
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

const MODEL_IGNORE_MESSAGES = {
  no_student_action: "No action or deadline for you was found in this notice.",
  not_applicable: "This notice does not apply to your program, year, or section.",
  no_new_information: "This information is already reflected in your schedule.",
  informational: "This notice is informational; nothing needs to be tracked.",
  uncertain: "This notice could not be matched to a clear task, so nothing was changed.",
  unspecified: "Nothing in this notice needs to be tracked.",
};

const ignored = (reason, event, changeSummary) => ({ action: "IGNORE", reason, event, changeSummary });

// Shared by the manual, PDF, and Classroom producers. One notice resolves to
// zero or more items. The response keeps its original shape, describing the
// first item that changed something, and lists every item under `results`.
// After each AcademicEvent is committed its Task is created or updated; that
// step never fails ingestion, and reconciliation repairs a missed Task.
// dependencies.taskContext.courseName, when a producer knows it, labels Tasks.
export async function ingestNotice(input, dependencies) {
  const notice = noticeSchema.parse(input);
  if ((notice.sourceType === "manual") !== (notice.sourceRef === null)) {
    throw new IngestionError(400, "INVALID_SOURCE", "The notice source is invalid.");
  }
  const { db, profileTableName, now = () => new Date() } = dependencies;
  const log = dependencies.log ?? defaultLog;
  const receivedAt = now();
  const events = await queryEvents(dependencies);
  const noticeId = noticeEventId(notice);

  // Skip the model entirely for a notice that was already fully ingested.
  const prior = events.filter((event) => event.eventId === noticeId || event.sourceMeta?.noticeId === noticeId);
  const expected = Math.max(1, ...prior.map((event) => event.sourceMeta?.itemCount ?? 1));
  if (prior.length >= expected) {
    const first = prior.find((event) => event.eventId === noticeId) ?? prior[0];
    const outcome = ignored("alreadyProcessed", first, "This notice was already received. Your current event has been kept.");
    return finish(notice, noticeId, [outcome], null, dependencies, log);
  }

  const start = receivedAt.getTime();
  const current = (event) => event.status === "ACTIVE" && (event.currentDeadline === null
    ? start - Date.parse(event.sourceMeta?.postedAt ?? receivedAt.toISOString()) <= UNDATED_WINDOW_MS
    : instantOf(event.currentDeadline) >= start && instantOf(event.currentDeadline) <= start + 14 * DAY_MS);
  const profileResult = await db.send(new GetCommand({
    TableName: profileTableName,
    Key: { userId: DEMO_USER_ID },
    // name, year, section, and timezone are all DynamoDB reserved words.
    ProjectionExpression: "#name, program, #year, #section, #tz",
    ExpressionAttributeNames: { "#name": "name", "#year": "year", "#section": "section", "#tz": "timezone" },
    ConsistentRead: true,
  }));
  const stored = profileResult.Item ? applicabilitySchema.parse(profileResult.Item) : null;
  const timeZone = isValidTimeZone(stored?.timezone) ? stored.timezone : DEFAULT_TIME_ZONE;
  const profile = stored ? { name: stored.name, program: stored.program, year: stored.year, section: stored.section } : null;
  const postedAt = notice.postedAt ? Date.parse(notice.postedAt) : start;

  const resolution = await resolveNotice({
    text: notice.text, sourceType: notice.sourceType, events: events.filter(current), profile, now: receivedAt,
    postedAt, updatedAt: notice.updatedAt ? Date.parse(notice.updatedAt) : null, timeZone,
  }, dependencies);
  if (!resolution.results.length) {
    const outcome = { ...ignored("modelIgnored", null, MODEL_IGNORE_MESSAGES[resolution.ignoreReason]), modelIgnoreReason: resolution.ignoreReason };
    return finish(notice, noticeId, [outcome], resolution.ignoreReason, dependencies, log);
  }

  const links = sourceLinks(notice.text);
  const context = { text: notice.text, anchorMs: postedAt, timeZone, links, single: resolution.results.length === 1 };
  const creates = resolution.results.filter((item) => item.action === "CREATE").length;
  const sourceMeta = { noticeId, itemCount: Math.max(1, creates), postedAt: notice.postedAt ?? receivedAt.toISOString(), updatedAt: notice.updatedAt ?? null };
  const outcomes = [];
  let createIndex = 0;
  for (const item of resolution.results) {
    const index = item.action === "CREATE" ? createIndex++ : null;
    try {
      outcomes.push(await applyItem(item, { notice, events, current, receivedAt, context, sourceMeta, index, db, tableName: dependencies.tableName, log }));
    } catch (error) {
      if (!(error instanceof IngestionError)) throw error;
      outcomes.push({ action: "FAILED", reason: null, event: null, changeSummary: error.message, error });
    }
  }
  // All items failing is a failed notice, reported exactly as before. Some
  // failing is a partial notice: the rest is kept, and a replay fills the gap.
  if (outcomes.every((outcome) => outcome.action === "FAILED")) throw outcomes[0].error;
  return finish(notice, noticeId, outcomes, null, dependencies, log);
}

async function applyItem(item, { notice, events, current, receivedAt, context, sourceMeta, index, db, tableName, log }) {
  const { action, changeSummary } = item;
  const historyEntry = `${receivedAt.toISOString()} — ${changeSummary || `Event ${action.toLowerCase()}.`}`;
  const replace = (event) => { events.splice(events.findIndex((entry) => entry.eventId === event.eventId), 1, event); };

  if (action === "CANCEL") {
    const target = events.find((event) => event.eventId === item.targetEventId && current(event));
    if (!target) throw new IngestionError(409, "UNKNOWN_TARGET", "The notice could not be matched to an active event in the next 14 days. Nothing was changed.");
    const event = await writeUpdate(db, tableName, target, { status: "CANCELLED" }, historyEntry);
    replace(event);
    return { action, reason: null, event, changeSummary };
  }

  const next = normaliseItem(item.eventDetails, context);
  if (!next.title) throw new IngestionError(502, "INVALID_MODEL_RESPONSE", "The notice did not identify an event title.");
  if (next.disagreed) log({ code: "DEADLINE_RESOLVED_IN_CODE", sourceRef: notice.sourceRef });
  const fields = { title: next.title, type: next.type, currentDeadline: next.currentDeadline, venue: next.venue, estimatedHours: next.estimatedHours, details: next.details };

  if (action === "CREATE") {
    const duplicate = events.find((event) => sameDetails(event, fields)) ?? events.find((event) => sameObligation(event, fields));
    if (duplicate) return ignored("duplicate", duplicate, "This item is already in your schedule.");
    const outsideWindowMatch = events.find((event) => event.status === "ACTIVE" && !current(event)
      && normalise(event.title) === normalise(fields.title) && event.type === fields.type);
    if (outsideWindowMatch) {
      throw new IngestionError(409, "OUTSIDE_COMPARISON_WINDOW", "An event with this title exists outside the 14-day comparison window. No duplicate was added.");
    }
    // The item's own slot first. A slot held by a different obligation (the
    // model listed items in another order on a replay) moves this item to the
    // next free deterministic slot, so a replay can neither duplicate nor
    // silently drop it.
    let slot = null;
    for (const candidate of [index, ...Array.from({ length: sourceMeta.itemCount + 10 }, (_, k) => k).filter((k) => k !== index)]) {
      const holder = events.find((event) => event.eventId === itemEventId(sourceMeta.noticeId, candidate));
      if (!holder) { slot = candidate; break; }
      if (normalise(holder.title) === normalise(fields.title) && holder.type === fields.type) {
        return ignored("alreadyProcessed", holder, "This notice was already received. Your current event has been kept.");
      }
    }
    if (slot === null) throw new IngestionError(409, "TOO_MANY_ITEMS", "This notice has more items than can be tracked. Nothing more was added.");
    const eventId = itemEventId(sourceMeta.noticeId, slot);
    const event = academicEventSchema.parse({
      userId: DEMO_USER_ID, eventId, ...fields,
      status: "ACTIVE", sourceType: notice.sourceType, sourceRef: notice.sourceRef,
      priorityScore: 0, changeHistory: [historyEntry],
      sourceMeta: { ...sourceMeta, itemIndex: slot },
    });
    try {
      await db.send(new PutCommand({
        TableName: tableName, Item: event,
        ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(eventId)",
      }));
    } catch (error) {
      if (error.name !== "ConditionalCheckFailedException") throw error;
      const existing = await db.send(new GetCommand({ TableName: tableName, Key: { userId: DEMO_USER_ID, eventId }, ConsistentRead: true }));
      if (!existing.Item) throw error;
      return ignored("alreadyProcessed", academicEventSchema.parse(existing.Item), "This notice was already received. Your current event has been kept.");
    }
    events.push(event);
    return { action, reason: null, event, changeSummary };
  }

  const target = events.find((event) => event.eventId === item.targetEventId && current(event));
  if (!target) throw new IngestionError(409, "UNKNOWN_TARGET", "The notice could not be matched to an active event in the next 14 days. Nothing was changed.");
  const merged = mergeUpdate(target, fields);
  if (sameDetails(target, merged)) return ignored("noChange", target, "This information is already reflected in your schedule.");
  const event = await writeUpdate(db, tableName, target, merged, historyEntry);
  replace(event);
  return { action, reason: null, event, changeSummary };
}

// Every truth-engine mutation appends history; its length is the optimistic
// concurrency check. The original source identity (sourceRef, sourceMeta) is
// always preserved, particularly a Classroom ID.
async function writeUpdate(db, tableName, target, change, historyEntry) {
  const names = { "#status": "status" };
  const values = { ":active": "ACTIVE", ":historyLength": target.changeHistory.length, ":entry": [historyEntry] };
  let update;
  if (change.status === "CANCELLED") {
    values[":cancelled"] = "CANCELLED";
    update = "SET #status = :cancelled, changeHistory = list_append(changeHistory, :entry)";
  } else {
    names["#type"] = "type";
    Object.assign(values, {
      ":title": change.title, ":type": change.type, ":deadline": change.currentDeadline,
      ":venue": change.venue, ":hours": change.estimatedHours, ":score": 0, ":details": change.details,
    });
    update = "SET title = :title, #type = :type, currentDeadline = :deadline, venue = :venue, estimatedHours = :hours, priorityScore = :score, details = :details, changeHistory = list_append(changeHistory, :entry)";
  }
  try {
    const result = await db.send(new UpdateCommand({
      TableName: tableName, Key: { userId: DEMO_USER_ID, eventId: target.eventId },
      ConditionExpression: "#status = :active AND size(changeHistory) = :historyLength",
      UpdateExpression: update, ExpressionAttributeNames: names, ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    }));
    return academicEventSchema.parse(result.Attributes);
  } catch (error) {
    if (error.name !== "ConditionalCheckFailedException") throw error;
    throw new IngestionError(409, "EVENT_CHANGED", "Your schedule changed while this notice was being processed. Refresh the list and try again.");
  }
}

// Syncs Tasks, logs a text-free trace of every decision, and shapes the
// response: the first changing item at the top level, all items in `results`.
async function finish(notice, noticeId, outcomes, modelIgnoreReason, dependencies, log) {
  const results = [];
  for (const outcome of outcomes) {
    const { error, ...result } = outcome;
    if (error) result.code = error.code;
    if (result.event) {
      const synced = await syncTaskForEvent(dependencies, result.event, dependencies.taskContext?.courseName ?? null);
      if (synced) result.taskId = synced.task.taskId;
    }
    results.push(result);
  }
  log({
    code: "TRUTH_RESOLUTION", sourceType: notice.sourceType, sourceRef: notice.sourceRef, noticeId,
    modelIgnoreReason, items: results.map((result) => ({ action: result.action, reason: result.reason ?? null, eventId: result.event?.eventId ?? null, error: result.code ?? null })),
  });
  const primary = results.find((result) => ["CREATE", "UPDATE", "CANCEL"].includes(result.action))
    ?? results.find((result) => result.action === "IGNORE") ?? results[0];
  return {
    action: primary.action, event: primary.event, changeSummary: primary.changeSummary,
    ...(primary.taskId ? { taskId: primary.taskId } : {}),
    reason: primary.reason ?? null,
    ...(modelIgnoreReason ? { modelIgnoreReason } : {}),
    partial: results.some((result) => result.action === "FAILED"),
    results,
  };
}
