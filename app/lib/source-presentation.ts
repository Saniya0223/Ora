import type { SyncResult } from "./types";

export function safeSourceLink(value: string | null | undefined, classroom = false): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (classroom && (url.protocol !== 'https:' || url.hostname !== 'classroom.google.com' || url.port)) return null;
    return url.href;
  } catch { return null; }
}

export function syncExplanation(result: SyncResult | null | undefined): string {
  if (!result) return "Sync details are not available yet.";
  const messages = [];
  if (result.needsReview) messages.push(`${result.needsReview} Classroom item(s) could not be matched safely. Review the original post; editing it will retry that item.`);
  if (result.rateLimited) messages.push("AI rate limit reached. Wait before syncing again; remaining items are saved for retry.");
  else if (result.temporaryFailed) messages.push(`${result.temporaryFailed} item(s) hit a temporary service issue. Retry sync.`);
  if (result.validationFailed) messages.push(`${result.validationFailed} item(s) could not be interpreted reliably. Retry or clarify the original post.`);
  if (result.raceSkipped) messages.push(`${result.raceSkipped} item(s) changed during processing. Retry sync to read the latest version.`);
  if (result.truncated && !result.rateLimited) messages.push("More items remain for the next sync.");
  if (!messages.length && result.failed) messages.push("Some items failed. Retry sync; existing tasks are preserved.");
  return messages.join(" ") || "All available Classroom items were processed.";
}
