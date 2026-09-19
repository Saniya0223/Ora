import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { syncClassroom } from "./classroom.js";
import { enrichUnestimatedTasks } from "./enrichment.js";
import { IngestionError } from "./errors.js";
import { USER_ID } from "./store.js";
import { loadProfile } from "./student-profile.js";

// A run holds the lease for longer than any Lambda can live (120 s), so a
// crashed run's lease simply expires and the next run proceeds.
export const LEASE_MS = 150_000;

// Map a failure to a code that is safe to store and show. Raw Google, AWS, and
// Groq messages never leave this function.
export function classifySyncError(error) {
  const google = error?.response?.data?.error ?? error?.message;
  if (google === "invalid_grant" || error?.response?.status === 401 || error?.code === 401) return "REAUTH_REQUIRED";
  if (google === "invalid_client") return "GOOGLE_CLIENT_CONFIG";
  if (error?.response?.status === 403 || error?.code === 403) return "CLASSROOM_ACCESS_DENIED";
  if (error instanceof IngestionError) return error.code;
  return "SYNC_FAILED";
}

async function writeStatus(db, tableName, status, { account, releaseLease = false } = {}) {
  const names = { "#s": "classroomSync" };
  const values = { ":s": status };
  let update = "SET #s = :s";
  if (account) { names["#a"] = "classroomAccount"; values[":a"] = account; update += ", #a = :a"; }
  if (releaseLease) { names["#l"] = "classroomSyncLease"; update += " REMOVE #l"; }
  await db.send(new UpdateCommand({ TableName: tableName, Key: { userId: USER_ID }, UpdateExpression: update, ExpressionAttributeNames: names, ExpressionAttributeValues: values }));
}

// The single entry point for every Classroom sync, scheduled or manual. It
// wraps the unchanged production syncClassroom and records what really
// happened, so the UI never reports "synced" merely because tokens exist.
//
// Returns { status, ...classroomSync } or { skipped: "IN_PROGRESS" | "DISCONNECTED" }.
export async function runClassroomSync(dependencies, { trigger = "scheduled", budgetMs = 100_000, enrich = true } = {}) {
  const { db, env } = dependencies;
  const tableName = env.STUDENT_PROFILE_TABLE;
  const clock = dependencies.now ?? (() => new Date());
  const startedAt = Date.now();
  const profile = await loadProfile(db, tableName);
  if (!profile?.classroomTokens || !profile.connectedCourses.length) return { skipped: "DISCONNECTED" };

  const previous = profile.classroomSync ?? null;
  const syncing = {
    status: "SYNCING", trigger, lastAttemptAt: clock().toISOString(),
    lastFinishedAt: previous?.lastFinishedAt ?? null,
    lastSuccessfulSyncAt: previous?.lastSuccessfulSyncAt ?? null,
    lastErrorCode: null, lastResult: previous?.lastResult ?? null,
  };
  try {
    await db.send(new UpdateCommand({
      TableName: tableName, Key: { userId: USER_ID },
      UpdateExpression: "SET #l = :lease, #s = :s",
      ConditionExpression: "attribute_exists(userId) AND (attribute_not_exists(#l) OR #l < :now)",
      ExpressionAttributeNames: { "#l": "classroomSyncLease", "#s": "classroomSync" },
      ExpressionAttributeValues: { ":lease": startedAt + LEASE_MS, ":s": syncing, ":now": startedAt },
    }));
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") return { skipped: "IN_PROGRESS" };
    throw error;
  }

  let finished;
  try {
    const { account, ...counts } = await syncClassroom({ ...dependencies, budgetMs, startedAt });
    const at = clock().toISOString();
    finished = {
      ...syncing,
      // PARTIAL: the source was reachable, but some items failed or the time
      // budget ran out. Those items keep their watermark and retry next run.
      status: counts.failed > 0 || counts.truncated ? "PARTIAL" : "SUCCESS",
      lastFinishedAt: at, lastSuccessfulSyncAt: at, lastResult: counts,
    };
    await writeStatus(db, tableName, finished, { account: account ? { ...account, fetchedAt: at } : undefined, releaseLease: true });
  } catch (error) {
    const code = classifySyncError(error);
    finished = { ...syncing, status: code === "REAUTH_REQUIRED" ? "REAUTH_REQUIRED" : "ERROR", lastFinishedAt: clock().toISOString(), lastErrorCode: code };
    try { await writeStatus(db, tableName, finished, { releaseLease: true }); } catch { /* the lease expires on its own */ }
    console.error(JSON.stringify({ code: "CLASSROOM_SYNC_FAILED", trigger, reason: code }));
    error.syncStatus = finished;
    throw error;
  }

  // Planning enrichment runs strictly after the sync is recorded, and can never
  // turn a successful sync into a failed one.
  if (enrich && env.TASKS_TABLE) {
    try { await enrichUnestimatedTasks(dependencies, env.TASKS_TABLE, { deadlineAt: startedAt + budgetMs, now: clock() }); }
    catch (error) { console.error(JSON.stringify({ code: "ENRICHMENT_SKIPPED", reason: error?.code ?? error?.name ?? "UNKNOWN" })); }
  }
  return finished;
}
