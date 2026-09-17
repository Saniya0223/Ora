export const DEMO_TIME_ZONE = "Asia/Kolkata";

// Prompt 1 and timetable slots use campus-local time. Never let the machine's
// timezone decide what a deadline means. Kolkata has a fixed +05:30 offset.
export function deadlineInstant(value) {
  return Date.parse(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}+05:30` : value);
}

export function campusDateTime(value) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: DEMO_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value));
  const fields = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}`;
}
