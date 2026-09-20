import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError, notFound } from "./api.js";
import { USER_ID, getItem, putNew, queryUser, updateVersioned } from "./store.js";

// The *_CLASS_TIME actions carry the timetable's next class as the deadline;
// USE_CLASS_TIME and KEEP_NO_DEADLINE are the create-only forms used when no task matches.
export const REVIEW_ACTIONS = ["UPDATE_EXISTING", "UPDATE_EXISTING_CLASS_TIME", "CREATE_NEW", "CREATE_NEW_CLASS_TIME", "USE_CLASS_TIME", "KEEP_NO_DEADLINE", "IGNORE", "CANCEL"];
const timestamp = z.iso.datetime({ offset: true });
const reviewSchema = z.object({
  userId: z.string(), reviewId: z.uuid(), version: z.number().int().nonnegative().default(0),
  status: z.enum(["OPEN", "RESOLVED"]), revision: z.string(), sourceType: z.enum(["manual", "pdf", "classroom"]),
  sourceRef: z.string().nullable(), sourceUrl: z.string().nullable(), sourceFileName: z.string().nullable(),
  sourceDocumentId: z.uuid().nullable(), noticeText: z.string().max(12_000), postedAt: timestamp.nullable(), updatedAt: timestamp.nullable(),
  itemIndex: z.number().int().nonnegative(), timeZone: z.string(),
  item: z.unknown().nullable(), detectedTitle: z.string(), ambiguity: z.string(), reasons: z.array(z.string()),
  candidates: z.array(z.object({ eventId: z.uuid(), title: z.string(), deadline: z.string().nullable(), sourceType: z.string(),
    type: z.string().nullable().default(null), why: z.array(z.string()).default([]) })),
  classLabel: z.string().nullable().default(null),
  suggestedDeadline: z.string().nullable(), recommendedAction: z.enum(REVIEW_ACTIONS), options: z.array(z.enum(REVIEW_ACTIONS)),
  createdAt: timestamp, changedAt: timestamp, resolvedAt: timestamp.nullable().default(null), resolution: z.string().nullable().default(null),
});

// A stable key per source item. A new Classroom revision updates the same
// review row; a replay of the same revision never produces another question.
export function reviewIdFor(notice, index = 0) {
  const input = JSON.stringify([notice.sourceType, notice.sourceRef ?? notice.text.trim().replace(/\r\n?/g, "\n"), index]);
  const bytes = createHash("sha1").update("campusflow-review").update(input).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const key = (reviewId) => ({ userId: USER_ID, reviewId });

export function publicReview(row) {
  const review = reviewSchema.parse(row);
  return {
    id: review.reviewId, status: review.status, sourceType: review.sourceType,
    sourceFileName: review.sourceFileName, sourceUrl: review.sourceUrl,
    sourceExcerpt: review.noticeText.slice(0, 500), detectedTitle: review.detectedTitle,
    ambiguity: review.ambiguity, reasons: review.reasons, candidates: review.candidates,
    suggestedDeadline: review.suggestedDeadline, classLabel: review.classLabel, recommendedAction: review.recommendedAction,
    options: review.options, createdAt: review.createdAt, updatedAt: review.changedAt,
  };
}

export async function getReview(db, tableName, reviewId) {
  if (!z.uuid().safeParse(reviewId).success) throw notFound("review");
  const row = await getItem(db, tableName, key(reviewId));
  if (!row) throw notFound("review");
  return reviewSchema.parse(row);
}

export async function listReviews(db, tableName) {
  const rows = await queryUser(db, tableName);
  return rows.map((row) => reviewSchema.parse(row)).filter((row) => row.status === "OPEN")
    .sort((left, right) => right.changedAt.localeCompare(left.changedAt)).map(publicReview);
}

export async function saveReview(db, tableName, draft, now) {
  const at = now.toISOString();
  const existing = await getItem(db, tableName, key(draft.reviewId));
  if (existing) {
    if (existing.revision === draft.revision) return reviewSchema.parse(existing);
    return reviewSchema.parse(await updateVersioned(db, tableName, key(draft.reviewId), (current) => ({
      ...current, ...draft, status: "OPEN", changedAt: at, resolvedAt: null, resolution: null,
    }), { what: "review" }));
  }
  const row = reviewSchema.parse({ userId: USER_ID, ...draft, status: "OPEN", createdAt: at, changedAt: at });
  if (await putNew(db, tableName, row, "reviewId")) return row;
  return getReview(db, tableName, draft.reviewId);
}

export async function resolveStoredReview(db, tableName, reviewId, revision, action, now) {
  return reviewSchema.parse(await updateVersioned(db, tableName, key(reviewId), (row) => {
    if (row.status === "RESOLVED" && row.revision === revision) return null;
    if (row.status !== "OPEN" || row.revision !== revision) throw new ApiError(409, "REVIEW_CHANGED", "This review changed. Refresh and decide on the latest version.");
    return { ...row, status: "RESOLVED", resolvedAt: now.toISOString(), changedAt: now.toISOString(), resolution: action };
  }, { what: "review" }));
}
