import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { ApiError, validate } from "./api.js";
import { ingestNotice } from "./ingestion.js";
import { getReview, publicReview, resolveStoredReview, REVIEW_ACTIONS } from "./reviews.js";
import { USER_ID } from "./store.js";

const CLASS_TIME_ACTIONS = new Set(["USE_CLASS_TIME", "UPDATE_EXISTING_CLASS_TIME", "CREATE_NEW_CLASS_TIME"]);
const UPDATE_ACTIONS = new Set(["UPDATE_EXISTING", "UPDATE_EXISTING_CLASS_TIME"]);
const CREATE_ACTIONS = new Set(["CREATE_NEW", "CREATE_NEW_CLASS_TIME"]);

const decisionSchema = z.strictObject({
  action: z.enum(REVIEW_ACTIONS), targetEventId: z.uuid().optional(),
});

async function clearClassroomReview(db, tableName, row) {
  if (!tableName || row.sourceType !== "classroom" || !row.sourceRef) return;
  const courseId = row.sourceRef.split(":")[0];
  for (let attempt = 0; attempt < 3; attempt++) {
    const key = { userId: USER_ID, courseId };
    const current = (await db.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))).Item;
    if (!current?.reviewItems?.some((item) => item.sourceRef === row.sourceRef)) return;
    const reviews = current.reviewItems.filter((item) => item.sourceRef !== row.sourceRef);
    const processed = [...(current.processedItems ?? []).filter((item) => item.sourceRef !== row.sourceRef),
      { sourceRef: row.sourceRef, revision: row.revision }].slice(-500);
    try {
      await db.send(new UpdateCommand({ TableName: tableName, Key: key,
        UpdateExpression: "SET #r = :reviews, #p = :processed",
        ConditionExpression: "#r = :oldReviews",
        ExpressionAttributeNames: { "#r": "reviewItems", "#p": "processedItems" },
        ExpressionAttributeValues: { ":oldReviews": current.reviewItems, ":reviews": reviews, ":processed": processed },
      }));
      return;
    } catch (error) {
      if (error.name !== "ConditionalCheckFailedException") throw error;
    }
  }
  throw new ApiError(409, "REVIEW_CHANGED", "Classroom sync changed while this review was being resolved. Refresh and retry.");
}

export async function decideReview(dependencies, reviewId, body, now = new Date()) {
  const { db, env } = dependencies;
  if (!env.SOURCE_REVIEWS_TABLE) throw new ApiError(503, "NOT_CONFIGURED", "Source reviews are not configured.");
  const input = validate(decisionSchema, body);
  const row = await getReview(db, env.SOURCE_REVIEWS_TABLE, reviewId);
  if (row.status === "RESOLVED") return { review: publicReview(row), outcome: null };
  if (!row.options.includes(input.action)) throw new ApiError(400, "INVALID_DECISION", "Choose an action offered for this review.");
  const candidateIds = new Set(row.candidates.map((candidate) => candidate.eventId));
  if (input.targetEventId && !candidateIds.has(input.targetEventId)) throw new ApiError(400, "INVALID_TARGET", "Choose a task listed in this review.");
  if ((UPDATE_ACTIONS.has(input.action) || input.action === "CANCEL") && !input.targetEventId) {
    throw new ApiError(400, "TARGET_REQUIRED", "Choose the existing task to change.");
  }

  let outcome = null;
  if (input.action !== "IGNORE") {
    const item = structuredClone(row.item);
    if (!item?.eventDetails && input.action !== "CANCEL") throw new ApiError(409, "REVIEW_INCOMPLETE", "The source did not provide enough detail. Create a manual task instead.");
    if (input.action === "CANCEL") {
      Object.assign(item, { action: "CANCEL", targetEventId: input.targetEventId, eventDetails: null });
    } else {
      // The *_EXISTING actions change the chosen task; the *_NEW actions always make a separate one.
      // The create-only forms (KEEP_NO_DEADLINE, USE_CLASS_TIME) follow the notice's own match, if any.
      const modelTarget = candidateIds.has(item?.targetEventId) ? item.targetEventId : null;
      const targetEventId = UPDATE_ACTIONS.has(input.action) ? input.targetEventId
        : CREATE_ACTIONS.has(input.action) ? null : (input.targetEventId ?? modelTarget);
      Object.assign(item, { action: targetEventId ? "UPDATE" : "CREATE", targetEventId });
      const details = item.eventDetails;
      const useClassTime = CLASS_TIME_ACTIONS.has(input.action);
      if (useClassTime && !row.suggestedDeadline) throw new ApiError(400, "INVALID_DECISION", "No class time is available to use.");
      if (useClassTime) Object.assign(details, { currentDeadline: row.suggestedDeadline, deadlineText: null, certainty: "confirmed" });
      else if (input.action === "KEEP_NO_DEADLINE") Object.assign(details, { currentDeadline: null, deadlineText: null, certainty: "confirmed" });
      // A code-made placeholder never renames or overwrites a task the student already has:
      // the task keeps its own title, type, summary and deadline (a null deadline is kept, not cleared).
      if (item.synthetic) {
        Object.assign(details, { certainty: "confirmed" });
        const target = row.candidates.find((candidate) => candidate.eventId === targetEventId);
        if (target) Object.assign(details, { title: target.title, type: target.type ?? details.type, actionSummary: null });
      }
    }
    outcome = await ingestNotice({ text: row.noticeText, sourceType: row.sourceType, sourceRef: row.sourceRef,
      postedAt: row.postedAt, updatedAt: row.updatedAt, sourceUrl: row.sourceUrl,
      ...(row.sourceFileName ? { sourceFileName: row.sourceFileName } : {}),
      ...(row.sourceDocumentId ? { sourceDocumentId: row.sourceDocumentId } : {}),
    }, { ...dependencies, tableName: env.ACADEMIC_EVENTS_TABLE, profileTableName: env.STUDENT_PROFILE_TABLE,
      now: () => now, reviewDecision: { item, itemIndex: row.itemIndex, targetEventId: item.targetEventId,
        forceCreate: CREATE_ACTIONS.has(input.action) } });
    if (outcome.partial || outcome.action === "FAILED" || outcome.action === "REVIEW") {
      throw new ApiError(409, "REVIEW_NOT_APPLIED", "The decision could not be applied safely. Refresh and try again.");
    }
  }
  const resolved = await resolveStoredReview(db, env.SOURCE_REVIEWS_TABLE, reviewId, row.revision, input.action, now);
  await clearClassroomReview(db, env.CLASSROOM_SYNC_STATE_TABLE, row);
  return { review: publicReview(resolved), outcome };
}
