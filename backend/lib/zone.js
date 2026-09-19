// General IANA timezone arithmetic for planning, dashboards, and timetables.
// Ingestion keeps its fixed campus offset in time.js; everything the student
// sees about "today" or "next class" uses the zone saved in their profile.
// All results are derived from Intl, never from the machine's local zone.

export const DEFAULT_TIME_ZONE = "Asia/Kolkata";
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const formatters = new Map();

function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat("en-GB", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }));
  }
  return formatters.get(timeZone);
}

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || !timeZone) return false;
  try { formatter(timeZone).format(0); return true; } catch { return false; }
}

// Wall-clock fields of an instant in a zone.
export function localParts(instant, timeZone) {
  const fields = Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
  const date = `${fields.year}-${fields.month}-${fields.day}`;
  const time = `${fields.hour}:${fields.minute}`;
  return { date, time, weekday: weekdayOf(date), minuteOfDay: Number(fields.hour) * 60 + Number(fields.minute) };
}

function offsetMs(instant, timeZone) {
  const fields = Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
  const asUtc = Date.UTC(+fields.year, +fields.month - 1, +fields.day, +fields.hour, +fields.minute, +fields.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

// The instant at which a zone's wall clock reads `date` `time` (HH:mm).
// Two passes resolve DST transitions; a skipped wall time lands just after it.
export function zonedInstant(date, time, timeZone) {
  const guess = Date.parse(`${date}T${time}:00Z`);
  let instant = guess - offsetMs(guess, timeZone);
  instant = guess - offsetMs(instant, timeZone);
  return instant;
}

export function weekdayOf(date) {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

export function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export const minutesOf = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
