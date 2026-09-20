import type { ReviewAction, SourceReview } from "./types";

// "2026-09-21T10:00" (already local to the student) -> "Monday at 10:00 AM".
export function classTimeLabel(local: string | null | undefined): string | null {
  const match = local ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local) : null;
  if (!match) return null;
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))));
  const hours = Number(match[4]);
  return `${weekday} at ${((hours + 11) % 12) + 1}:${match[5]} ${hours < 12 ? "AM" : "PM"}`;
}

export const requiresTarget = (action: ReviewAction) =>
  action === "UPDATE_EXISTING" || action === "UPDATE_EXISTING_CLASS_TIME" || action === "CANCEL";

// Labels follow the review: a class checkpoint names the class and time; a plain
// similarity question does not mention them.
export function actionLabel(review: Pick<SourceReview, "classLabel" | "suggestedDeadline">, action: ReviewAction): string {
  const when = classTimeLabel(review.suggestedDeadline);
  const nextClass = when ? `next ${review.classLabel ?? ""} class (${when})`.replace("  ", " ") : "next class";
  const hasClassTime = Boolean(review.suggestedDeadline);
  switch (action) {
    case "UPDATE_EXISTING_CLASS_TIME": return `Update the existing task and use the ${nextClass}`;
    case "UPDATE_EXISTING": return hasClassTime ? "Update the existing task without a deadline" : "Update an existing task";
    case "CREATE_NEW_CLASS_TIME": return `Create a separate task and use the ${nextClass}`;
    case "CREATE_NEW": return hasClassTime ? "Create a separate task without a deadline" : "Create a separate task";
    case "USE_CLASS_TIME": return `Create a task due at the ${nextClass}`;
    case "KEEP_NO_DEADLINE": return "Create a task without a deadline";
    case "CANCEL": return "Cancel the existing task";
    default: return "Ignore this update";
  }
}

export const sourceLabel = (sourceType: string) =>
  sourceType === "classroom" ? "Google Classroom" : sourceType === "pdf" ? "PDF" : "Notice";

export function candidateMeta(candidate: SourceReview["candidates"][number], formatDate: (iso: string) => string): string {
  return [candidate.type ? candidate.type.charAt(0).toUpperCase() + candidate.type.slice(1).toLowerCase() : "Task",
    candidate.deadline ? `Due ${formatDate(candidate.deadline)}` : "No deadline", sourceLabel(candidate.sourceType)].join(" · ");
}

// The recommended action's own target when it needs one; otherwise the strongest match.
export const defaultTarget = (review: Pick<SourceReview, "candidates">) => review.candidates[0]?.eventId ?? "";

export const canConfirm = (action: ReviewAction, targetEventId: string, busy: boolean) =>
  !busy && (!requiresTarget(action) || Boolean(targetEventId));

export const decisionBody = (action: ReviewAction, targetEventId: string) =>
  requiresTarget(action) ? { action, targetEventId } : { action };
