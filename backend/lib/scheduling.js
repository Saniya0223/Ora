import { campusDateTime, deadlineInstant } from "./time.js";

const typeWeight = { Exam: 1, Assignment: 0.8, Admin: 0.5, Lab: 0.7, Club: 0.3, Lecture: 0.2 };
const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const priorityLabel = (score) => score >= 0.7 ? "High" : score >= 0.45 ? "Medium" : "Low";

export function scoreEvents(events, now) {
  return events.filter((event) => event.status === "ACTIVE").map((event) => {
    const hoursUntilDeadline = (deadlineInstant(event.currentDeadline) - now.getTime()) / 3_600_000;
    const urgencyScore = Math.max(0, 1 - hoursUntilDeadline / (14 * 24));
    const effortScore = Math.min(1, event.estimatedHours / 6);
    return { ...event, priorityScore: urgencyScore * 0.5 + effortScore * 0.3 + typeWeight[event.type] * 0.2 };
  }).sort((a, b) => b.priorityScore - a.priorityScore || deadlineInstant(a.currentDeadline) - deadlineInstant(b.currentDeadline) || a.eventId.localeCompare(b.eventId));
}

export function detectCollisions(events, threshold = 6) {
  const ordered = [...events].filter((event) => event.status === "ACTIVE").sort((a, b) => deadlineInstant(a.currentDeadline) - deadlineInstant(b.currentDeadline));
  const collisions = [];
  const seen = new Set();
  for (const start of ordered) {
    const floor = deadlineInstant(start.currentDeadline);
    const involved = ordered.filter((event) => deadlineInstant(event.currentDeadline) >= floor && deadlineInstant(event.currentDeadline) <= floor + 48 * 3_600_000);
    const estimatedHours = involved.reduce((sum, event) => sum + event.estimatedHours, 0);
    const key = involved.map((event) => event.eventId).sort().join(",");
    if (estimatedHours > threshold && !seen.has(key)) {
      seen.add(key);
      collisions.push({ start: new Date(floor).toISOString(), end: new Date(floor + 48 * 3_600_000).toISOString(), eventIds: involved.map((event) => event.eventId), estimatedHours, threshold });
    }
  }
  // Keep the maximal groups; a subset of the same collision adds no information.
  return collisions.filter((collision) => !collisions.some((other) => other.eventIds.length > collision.eventIds.length && collision.eventIds.every((id) => other.eventIds.includes(id))));
}

export function expandTimetable(slots, now) {
  const today = campusDateTime(now).slice(0, 10);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(`${today}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + index);
    const date = day.toISOString().slice(0, 10);
    const classes = slots.filter((slot) => slot.day === weekdays[day.getUTCDay()]).map((slot) => ({
      ...slot, date, start: `${date}T${slot.startTime}+05:30`, end: `${date}T${slot.endTime}+05:30`,
    })).sort((a, b) => a.startTime.localeCompare(b.startTime));
    return { date, classes };
  });
}

export function allocateWork(events, timetable, now, dailyStudyHours = 4) {
  if (!Number.isFinite(dailyStudyHours) || dailyStudyHours <= 0 || dailyStudyHours > 14) throw new Error("Daily study hours must be between 0 and 14");
  const days = timetable.map(({ date, classes }) => {
    // Study is placed between 08:00 and 22:00 around the union of class intervals.
    // Internal intervals enforce deadlines; the persisted contract stays day-based.
    const start = Math.max(Date.parse(`${date}T08:00+05:30`), now.getTime());
    const end = Date.parse(`${date}T22:00+05:30`);
    let free = start < end ? [{ start, end }] : [];
    for (const slot of classes) {
      const classStart = Date.parse(slot.start);
      const classEnd = Date.parse(slot.end);
      free = free.flatMap((interval) => {
        if (classEnd <= interval.start || classStart >= interval.end) return [interval];
        return [
          ...(classStart > interval.start ? [{ start: interval.start, end: classStart }] : []),
          ...(classEnd < interval.end ? [{ start: classEnd, end: interval.end }] : []),
        ];
      });
    }
    return { date, free, remaining: dailyStudyHours * 3_600_000, blocks: [] };
  });
  const unallocated = [];
  for (const event of events) {
    let remaining = event.estimatedHours * 3_600_000;
    const deadline = deadlineInstant(event.currentDeadline);
    for (const day of days) {
      let allocated = 0;
      for (const interval of day.free) {
        const available = Math.max(0, Math.min(interval.end, deadline) - interval.start);
        const duration = Math.min(remaining, available, day.remaining);
        interval.start += duration;
        day.remaining -= duration;
        remaining -= duration;
        allocated += duration;
      }
      if (allocated > 0) day.blocks.push({ eventId: event.eventId, task: `Work on ${event.title}`, allocatedHours: allocated / 3_600_000, priority: priorityLabel(event.priorityScore) });
    }
    if (remaining > 0.001) unallocated.push({ eventId: event.eventId, remainingHours: remaining / 3_600_000, reason: deadline <= now.getTime() ? "Deadline has passed" : "Not enough available study time before the deadline within the next seven days" });
  }
  return { days: days.map(({ date, blocks }) => ({ date, blocks })), unallocated };
}
