import { createHash } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { academicEventSchema, studentProfileSchema } from "./contracts.js";
import { resolveNotice } from "./bedrock.js";
import { IngestionError } from "./errors.js";
import { syncTaskForEvent } from "./tasks.js";
import { deadlineInstant } from "./time.js";

export const DEMO_USER_ID = "demo-user";
export const noticeTextSchema = z.string().trim().min(1).max(12_000);
const noticeSchema = z.strictObject({
  text: noticeTextSchema,
  sourceType: z.enum(["manual", "pdf", "classroom"]),
  sourceRef: z.string().min(1).nullable(),
});
const applicabilitySchema = studentProfileSchema.pick({ name: true, program: true, year: true, section: true });
const normalise = (value) => (value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");

// UUID v5: the same source notice gets the same CREATE key, including on a
// retry after a lost response. The DynamoDB schema still contains only a UUID.
export function noticeEventId({ text, sourceType, sourceRef }) {
  const namespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const name = JSON.stringify(["campusflow", DEMO_USER_ID, sourceType, sourceRef, text.trim().replace(/\r\n?/g, "\n")]);
  const bytes = createHash("sha1").update(namespace).update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

function sameDetails(event, details) {
  return normalise(event.title) === normalise(details.title)
    && event.type === details.type
    && deadlineInstant(event.currentDeadline) === deadlineInstant(details.currentDeadline)
    && normalise(event.venue) === normalise(details.venue)
    && event.estimatedHours === details.estimatedHours;
}

function unchanged(event, changeSummary = "This information is already reflected in your schedule.") {
  return { action: "IGNORE", event, changeSummary };
}

// Shared by the manual, PDF, and Classroom producers. After the AcademicEvent
// is committed, its student-facing Task is created or updated. That step never
// fails ingestion; a missed Task is repaired by reconciliation on the next read.
// dependencies.taskContext.courseName, when a producer knows it, labels the Task.
export async function ingestNotice(input, dependencies) {
  const result = await resolveAndApplyNotice(input, dependencies);
  if (result.event) {
    const synced = await syncTaskForEvent(dependencies, result.event, dependencies.taskContext?.courseName ?? null);
    if (synced) return { ...result, taskId: synced.task.taskId };
  }
  return result;
}

// Only trusted callers supply provenance; it never comes from the browser body.
async function resolveAndApplyNotice(input, dependencies) {
  const notice = noticeSchema.parse(input);
  if ((notice.sourceType === "manual") !== (notice.sourceRef === null)) {
    throw new IngestionError(400, "INVALID_SOURCE", "The notice source is invalid.");
  }
  const { db, tableName, profileTableName, now = () => new Date() } = dependencies;
  const receivedAt = now();
  const events = await queryEvents(dependencies);
  const eventId = noticeEventId(notice);
  const previousCreate = events.find((event) => event.eventId === eventId);
  if (previousCreate) return unchanged(previousCreate, "This notice was already received. Your current event has been kept.");

  const end = receivedAt.getTime() + 14 * 24 * 60 * 60 * 1000;
  const currentEvents = events.filter((event) => event.status === "ACTIVE"
    && deadlineInstant(event.currentDeadline) >= receivedAt.getTime()
    && deadlineInstant(event.currentDeadline) <= end);
  const profileResult = await db.send(new GetCommand({
    TableName: profileTableName,
    Key: { userId: DEMO_USER_ID },
    ProjectionExpression: "#name, program, #year, #section",
    ExpressionAttributeNames: { "#name": "name", "#year": "year", "#section": "section" },
    ConsistentRead: true,
  }));
  const profile = profileResult.Item ? applicabilitySchema.parse(profileResult.Item) : null;
  const resolution = await resolveNotice({ ...notice, events: currentEvents, profile, now: receivedAt }, dependencies);
  const { action, eventDetails, changeSummary } = resolution;
  if (action === "IGNORE") return unchanged(null, changeSummary);

  const details = {
    ...eventDetails,
    title: eventDetails.title.trim(),
    currentDeadline: new Date(deadlineInstant(eventDetails.currentDeadline)).toISOString(),
    venue: (eventDetails.venue ?? "").trim() || null,
  };
  if (!details.title) throw new IngestionError(502, "INVALID_MODEL_RESPONSE", "The notice did not identify an event title.");
  const historyEntry = `${receivedAt.toISOString()} — ${changeSummary || `Event ${action.toLowerCase()}.`}`;

  if (action === "CREATE") {
    const duplicate = events.find((event) => sameDetails(event, details));
    if (duplicate) return unchanged(duplicate);
    const outsideWindowMatch = events.find((event) => event.status === "ACTIVE"
      && !currentEvents.some((current) => current.eventId === event.eventId)
      && normalise(event.title) === normalise(details.title) && event.type === details.type);
    if (outsideWindowMatch) {
      throw new IngestionError(409, "OUTSIDE_COMPARISON_WINDOW", "An event with this title exists outside the 14-day comparison window. No duplicate was added.");
    }
    const event = academicEventSchema.parse({
      userId: DEMO_USER_ID, eventId, ...details,
      status: "ACTIVE", sourceType: notice.sourceType, sourceRef: notice.sourceRef,
      priorityScore: 0, changeHistory: [historyEntry],
    });
    try {
      await db.send(new PutCommand({
        TableName: tableName, Item: event,
        ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(eventId)",
      }));
    } catch (error) {
      if (error.name !== "ConditionalCheckFailedException") throw error;
      const existing = await db.send(new GetCommand({
        TableName: tableName, Key: { userId: DEMO_USER_ID, eventId }, ConsistentRead: true,
      }));
      if (!existing.Item) throw error;
      return unchanged(academicEventSchema.parse(existing.Item));
    }
    return { action, event, changeSummary };
  }

  const target = currentEvents.find((event) => event.eventId === resolution.targetEventId);
  if (!target) {
    throw new IngestionError(409, "UNKNOWN_TARGET", "The notice could not be matched to an active event in the next 14 days. Nothing was changed.");
  }
  if (action === "UPDATE" && sameDetails(target, details)) return unchanged(target);

  // Preserve the original source identity, particularly a future Classroom ID.
  // Every truth-engine mutation appends history; its length is the optimistic
  // concurrency check, without introducing a new version field into the schema.
  const next = academicEventSchema.parse({
    ...target,
    ...(action === "UPDATE" ? { ...details, priorityScore: 0 } : { status: "CANCELLED" }),
    changeHistory: [...target.changeHistory, historyEntry],
  });
  const names = { "#status": "status" };
  const values = { ":active": "ACTIVE", ":historyLength": target.changeHistory.length, ":entry": [historyEntry] };
  let update = "SET #status = :cancelled, changeHistory = list_append(changeHistory, :entry)";
  if (action === "CANCEL") values[":cancelled"] = "CANCELLED";
  else {
    names["#type"] = "type";
    Object.assign(values, {
      ":title": next.title, ":type": next.type, ":deadline": next.currentDeadline,
      ":venue": next.venue, ":hours": next.estimatedHours, ":score": 0,
    });
    update = "SET title = :title, #type = :type, currentDeadline = :deadline, venue = :venue, estimatedHours = :hours, priorityScore = :score, changeHistory = list_append(changeHistory, :entry)";
  }
  try {
    const result = await db.send(new UpdateCommand({
      TableName: tableName, Key: { userId: DEMO_USER_ID, eventId: target.eventId },
      ConditionExpression: "#status = :active AND size(changeHistory) = :historyLength",
      UpdateExpression: update, ExpressionAttributeNames: names, ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    }));
    return { action, event: academicEventSchema.parse(result.Attributes), changeSummary };
  } catch (error) {
    if (error.name !== "ConditionalCheckFailedException") throw error;
    throw new IngestionError(409, "EVENT_CHANGED", "Your schedule changed while this notice was being processed. Refresh the list and try again.");
  }
}
