import { PRIORITY_RANK } from "./priority.js";
import { classOccurrences, ensurePlanFresh, plannerRange } from "./planner.js";
import { sourcesDTO } from "./sources.js";
import { academicWeek } from "./student-profile.js";
import { toTaskDTO } from "./tasks.js";
import { addDays, localParts, zonedInstant } from "./zone.js";

const byPriority = (a, b) => (PRIORITY_RANK[a.effectivePriority] ?? 3) - (PRIORITY_RANK[b.effectivePriority] ?? 3)
  || (a.deadline ? Date.parse(a.deadline) : Infinity) - (b.deadline ? Date.parse(b.deadline) : Infinity)
  || a.id.localeCompare(b.id);

// One call returns everything the Dashboard shows, computed from real data in
// the student's timezone. Definitions (also in the API contract):
//   tasksToday          OPEN tasks due today or overdue, or with a study block today
//   highPriority        how many of tasksToday have effectivePriority HIGH
//   highPriorityOpen    all OPEN tasks with effectivePriority HIGH
//   plannedStudyMinutes minutes of valid STUDY blocks on today's calendar
export async function buildDashboard(dependencies, now) {
  const context = await ensurePlanFresh(dependencies, now);
  const { profile, preferences, timeZone, tasks } = context.inputs;
  const nowMs = now.getTime();
  const today = localParts(nowMs, timeZone).date;
  const dayEnd = zonedInstant(addDays(today, 1), "00:00", timeZone);
  const dailyStudyMinutes = preferences.dailyStudyHours * 60;
  const dtos = tasks.map((task) => toTaskDTO(task, { now, dailyStudyMinutes }));

  const range = await plannerRange(dependencies, { from: today, to: today }, now, context);
  const study = range.blocks.filter((block) => block.type === "STUDY");
  const scheduledIds = new Set(study.map((block) => block.taskId).filter(Boolean));
  const open = dtos.filter((dto) => dto.status === "OPEN");
  const todayTasks = open.filter((dto) => (dto.deadline && Date.parse(dto.deadline) < dayEnd) || scheduledIds.has(dto.id));
  const minutes = (block) => Math.round((Date.parse(block.end) - Date.parse(block.start)) / 60_000);

  const schedule = [
    ...range.classes.map((item) => ({ id: item.id, kind: item.type, title: item.title, classType: item.classType, start: item.start, end: item.end, location: item.location, taskId: null })),
    ...range.blocks.map((item) => ({ id: item.id, kind: item.type, title: item.title, classType: null, start: item.start, end: item.end, location: item.location, taskId: item.taskId })),
  ].sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  const nextIndex = schedule.findIndex((item) => Date.parse(item.start) > nowMs);
  const todaySchedule = schedule.map((item, index) => ({
    ...item,
    isPast: Date.parse(item.end) <= nowMs,
    isCurrent: Date.parse(item.start) <= nowMs && Date.parse(item.end) > nowMs,
    isNext: index === nextIndex,
  }));

  // The next class that has not ended, looking up to a week ahead.
  const upcoming = classOccurrences(profile.timetableSlots, today, addDays(today, 7), timeZone).find((item) => Date.parse(item.end) > nowMs) ?? null;
  const nextClass = upcoming && {
    title: upcoming.title, classType: upcoming.classType, type: upcoming.type, start: upcoming.start, end: upcoming.end,
    location: upcoming.location, inProgress: Date.parse(upcoming.start) <= nowMs,
  };

  const completedToday = dtos.filter((dto) => dto.status === "COMPLETED" && dto.completedAt && localParts(Date.parse(dto.completedAt), timeZone).date === today);
  const sources = await sourcesDTO(dependencies.db, dependencies.tables, profile, now);
  return {
    profile: { name: profile.name, program: profile.program, year: profile.year, section: profile.section, semester: profile.semester ?? null, academicWeek: academicWeek(profile, now) },
    date: { now: now.toISOString(), today, weekday: localParts(nowMs, timeZone).weekday, timezone: timeZone },
    summary: {
      tasksToday: todayTasks.length,
      highPriority: todayTasks.filter((dto) => dto.effectivePriority === "HIGH").length,
      highPriorityOpen: open.filter((dto) => dto.effectivePriority === "HIGH").length,
      overdue: open.filter((dto) => dto.isOverdue).length,
      plannedStudyMinutes: study.reduce((sum, block) => sum + minutes(block), 0),
      completedToday: completedToday.length,
    },
    nextClass,
    priorities: [...open].sort(byPriority).slice(0, 5).map((dto) => ({ ...dto, dueToday: Boolean(dto.deadline && Date.parse(dto.deadline) < dayEnd), scheduledToday: scheduledIds.has(dto.id) })),
    completedToday: completedToday.slice(0, 5),
    todaySchedule,
    capacity: context.planningState.capacity ?? null,
    sync: { classroom: { connection: sources.classroom.connection, health: sources.classroom.health, status: sources.classroom.sync.status, lastSuccessfulSyncAt: sources.classroom.sync.lastSuccessfulSyncAt } },
  };
}
