import type { Sources, SyncResult } from "./types";

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
  if (result.needsReview) messages.push(`${result.needsReview} Classroom item(s) need your decision in Updates needing review.`);
  if (result.rateLimited) messages.push("AI rate limit reached. Wait before syncing again; remaining items are saved for retry.");
  else if (result.temporaryFailed) messages.push(`${result.temporaryFailed} item(s) hit a temporary service issue. Retry sync.`);
  if (result.validationFailed) messages.push(`${result.validationFailed} item(s) could not be interpreted reliably. Retry or clarify the original post.`);
  if (result.raceSkipped) messages.push(`${result.raceSkipped} item(s) changed during processing. Retry sync to read the latest version.`);
  if (result.truncated && !result.rateLimited) messages.push("More items remain for the next sync.");
  if (!messages.length && result.failed) messages.push("Some items failed. Retry sync; existing tasks are preserved.");
  return messages.join(" ") || "All available Classroom items were processed.";
}

// Names a resource link by what it points to; model-written labels are often
// vague ("Repo links" for a Google Form), so a recognised kind wins.
const linkKinds: [RegExp, string][] = [
  [/^(docs\.google\.com\/forms|forms\.gle)\b/, "Google Form"],
  [/^docs\.google\.com\/document\b/, "Google Doc"],
  [/^docs\.google\.com\/spreadsheets\b/, "Google Sheet"],
  [/^docs\.google\.com\/presentation\b/, "Google Slides"],
  [/^drive\.google\.com\b/, "Google Drive file"],
  [/^(www\.)?github\.com\b/, "GitHub repository"],
  [/^(www\.)?(youtube\.com|youtu\.be)\b/, "YouTube video"],
];

export function linkLabel(url: string, label: string | null | undefined): string {
  const { hostname, pathname } = new URL(url);
  const kind = linkKinds.find(([pattern]) => pattern.test(hostname + pathname));
  return kind?.[1] ?? label ?? hostname;
}

export function timeAgo(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export type SyncSummary = {
  tone: "ok" | "busy" | "review" | "warn" | "error";
  title: string;
  detail: string | null;
  changes: string[];
};

// One student-facing reading of the Classroom sync state, shared by the
// sidebar and the Connected Sources card. Raw counters stay in "Details".
export function syncSummary(classroom: Sources["classroom"], now = Date.now()): SyncSummary {
  const { sync, health } = classroom;
  const result = sync.lastResult;
  if (classroom.connection !== "CONNECTED" || health === "DISCONNECTED")
    return { tone: "warn", title: "Not connected", detail: "Connect Google Classroom to bring in your coursework.", changes: [] };
  if (health === "REAUTH_REQUIRED" || sync.status === "REAUTH_REQUIRED")
    return { tone: "error", title: "Reconnect Google Classroom", detail: "Ora's access expired. Reconnect to keep syncing.", changes: [] };
  if (sync.status === "SYNCING" || health === "SYNCING")
    return { tone: "busy", title: "Syncing Classroom…", detail: "Checking for new announcements and coursework", changes: [] };
  if (health === "NEVER_SYNCED" || sync.status === "NEVER_SYNCED")
    return { tone: "warn", title: "Not synced yet", detail: "Sync now to bring in your Classroom work.", changes: [] };
  if (sync.status === "ERROR" || health === "ERROR") {
    const detail = sync.lastErrorCode === "CLASSROOM_ACCESS_DENIED"
      ? "Ora can no longer read a selected course. Reconnect or choose courses again."
      : "Classroom couldn't be synced right now. Try again shortly.";
    return { tone: "error", title: "Couldn't sync Classroom", detail, changes: [] };
  }
  const changes = result ? [
    result.created ? plural(result.created, "new task added", "new tasks added") : "",
    result.updated ? plural(result.updated, "task updated", "tasks updated") : "",
    result.cancelled ? plural(result.cancelled, "task cancelled", "tasks cancelled") : "",
  ].filter(Boolean) : [];
  if (result?.needsReview)
    return { tone: "review", title: `${result.needsReview} Classroom update${result.needsReview === 1 ? "" : "s"} need${result.needsReview === 1 ? "s" : ""} review`, detail: "Review the uncertain source update before changing a task.", changes };
  if (result && (result.rateLimited || result.temporaryFailed || result.validationFailed || result.raceSkipped || result.failed))
    return { tone: "warn", title: "Some Classroom items could not be synced", detail: "You can try again shortly. Your existing tasks are safe.", changes };
  if (health === "STALE")
    return { tone: "warn", title: "Classroom sync is delayed", detail: "Automatic syncing will retry. You can also sync now.", changes: [] };
  if (changes.length)
    return { tone: "ok", title: result?.updated === 1 && !result.created && !result.cancelled ? "1 task updated" : "Classroom changes synced", detail: result?.truncated ? "More items will sync next time." : null, changes };
  return { tone: "ok", title: "You're up to date", detail: "No new Classroom changes", changes: [] };
}
