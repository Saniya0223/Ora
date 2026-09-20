import type { FocusSession, SourceHealth, SyncStatus } from "./types";
export function duration(minutes: number | null) {
  if (minutes === null) return "Estimate pending";
  const n = Math.round(minutes);
  return n === 0
    ? "0 min"
    : [
        Math.floor(n / 60) ? `${Math.floor(n / 60)} h` : "",
        n % 60 ? `${n % 60} min` : "",
      ]
        .filter(Boolean)
        .join(" ");
}
export function clock(value: string, timezone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}
export function clock12h(value: string, timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(value)).replace(" ", "").toLowerCase();
}
// "9:00 – 10:00am": the meridiem is written once when both ends share it.
export function timeRange(start: string, end: string, timezone: string) {
  const from = clock12h(start, timezone);
  const to = clock12h(end, timezone);
  return from.slice(-2) === to.slice(-2) ? `${from.slice(0, -2)} – ${to}` : `${from} – ${to}`;
}
export function dateKey(value: string | Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  return ["year", "month", "day"]
    .map((k) => parts.find((p) => p.type === k)?.value)
    .join("-");
}
export function deadline(value: string | null, timezone: string) {
  return value
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : "No deadline";
}
export function addDays(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function monday(date: string) {
  return addDays(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));
}
export function localInput(instant: string | null, timezone: string) {
  return instant
    ? `${dateKey(instant, timezone)}T${clock(instant, timezone)}`
    : "";
}
export function focusRemaining(
  session: FocusSession,
  sampledAt: number,
  now: number,
) {
  const extra = session.isRunning ? Math.max(0, (now - sampledAt) / 1000) : 0;
  return Math.max(
    0,
    Math.ceil(session.plannedMinutes * 60 - session.elapsedSeconds - extra),
  );
}
export function syncLabel(health: SourceHealth, status: SyncStatus) {
  if (status === "PARTIAL" && health === "HEALTHY") return "Partially synced";
  return {
    DISCONNECTED: "Not connected",
    NEVER_SYNCED: "Never synced",
    SYNCING: "Syncing",
    HEALTHY: "Synced",
    STALE: "Sync needed",
    ERROR: "Sync failed",
    REAUTH_REQUIRED: "Reconnect required",
  }[health];
}
export type CalendarItem = {
  id: string;
  title: string;
  start: string;
  end: string;
  type: string;
  taskId?: string | null;
  location?: string | null;
  outsidePreferredWindow?: boolean;
};
export function daySegments(
  items: CalendarItem[],
  day: string,
  timezone: string,
) {
  return items
    .filter(
      (i) =>
        dateKey(i.start, timezone) <= day && dateKey(i.end, timezone) >= day,
    )
    .map((i) => {
      const start =
        dateKey(i.start, timezone) < day
          ? 0
          : toMinutes(clock(i.start, timezone));
      const end =
        dateKey(i.end, timezone) > day
          ? 1440
          : toMinutes(clock(i.end, timezone));
      return { ...i, startMinute: start, endMinute: end };
    })
    .filter((i) => i.endMinute > i.startMinute);
}
export function toMinutes(time: string) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}
export function placeOverlaps<
  T extends { startMinute: number; endMinute: number },
>(items: T[]) {
  const result: (T & { column: number; columns: number })[] = [];
  let group: typeof result = [];
  let ends: number[] = [];
  let groupEnd = -1;
  const flush = () => {
    group.forEach((i) => {
      i.columns = ends.length;
      result.push(i);
    });
    group = [];
    ends = [];
  };
  for (const i of [...items].sort(
    (a, b) => a.startMinute - b.startMinute || b.endMinute - a.endMinute,
  )) {
    if (i.startMinute >= groupEnd) flush();
    let column = ends.findIndex((end) => end <= i.startMinute);
    if (column < 0) column = ends.length;
    ends[column] = i.endMinute;
    group.push({ ...i, column, columns: 1 });
    groupEnd = Math.max(groupEnd, i.endMinute);
  }
  flush();
  return result;
}
