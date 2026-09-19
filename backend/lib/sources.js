import { queryUser } from "./store.js";

// Scheduled syncs run every 15 minutes; a connected source with no successful
// sync for longer than this is reported as stale.
const STALE_AFTER_MS = 45 * 60_000;

// Health distinguishes the connection (do we hold Google credentials?) from
// the sync (did the last run actually succeed?). Holding credentials alone is
// never reported as healthy.
export function classroomSource(profile, syncRows, now) {
  const connected = Boolean(profile?.classroomTokens);
  const names = new Map(syncRows.map((row) => [row.courseId, row]));
  const record = profile?.classroomSync ?? null;
  const leaseActive = (profile?.classroomSyncLease ?? 0) > now.getTime();
  let status = record?.status ?? "NEVER_SYNCED";
  let lastErrorCode = record?.lastErrorCode ?? null;
  // A run that died mid-way leaves SYNCING with an expired lease.
  if (status === "SYNCING" && !leaseActive) { status = "ERROR"; lastErrorCode = "SYNC_INTERRUPTED"; }
  const lastSuccess = record?.lastSuccessfulSyncAt ? Date.parse(record.lastSuccessfulSyncAt) : null;
  const stale = connected && (lastSuccess === null || now.getTime() - lastSuccess > STALE_AFTER_MS);
  const health = !connected ? "DISCONNECTED"
    : status === "REAUTH_REQUIRED" ? "REAUTH_REQUIRED"
      : status === "SYNCING" ? "SYNCING"
        : status === "ERROR" ? "ERROR"
          : status === "NEVER_SYNCED" ? "NEVER_SYNCED"
            : stale ? "STALE" : "HEALTHY";
  return {
    connection: connected ? "CONNECTED" : "DISCONNECTED",
    health,
    account: profile?.classroomAccount ? { email: profile.classroomAccount.email, name: profile.classroomAccount.name } : null,
    selectedCourses: (profile?.connectedCourses ?? []).map((id) => ({ id, name: names.get(id)?.courseName ?? null, lastSyncedAt: names.get(id)?.lastSyncedAt ?? null })),
    sync: {
      status, trigger: record?.trigger ?? null, stale,
      lastAttemptAt: record?.lastAttemptAt ?? null, lastFinishedAt: record?.lastFinishedAt ?? null,
      lastSuccessfulSyncAt: record?.lastSuccessfulSyncAt ?? null, lastErrorCode, lastResult: record?.lastResult ?? null,
    },
  };
}

export function timetableSource(profile) {
  const count = profile?.timetableSlots?.length ?? 0;
  return {
    status: count ? "READY" : "NOT_IMPORTED",
    slotCount: count,
    source: profile?.timetableSource ?? null,
  };
}

export async function sourcesDTO(db, tables, profile, now) {
  const rows = tables.syncState ? await queryUser(db, tables.syncState) : [];
  return { classroom: classroomSource(profile, rows, now), timetable: timetableSource(profile) };
}
