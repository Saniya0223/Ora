// Deterministic priority. No model is involved: the same task, clock, and
// study limit always produce the same level and reason.
//
// Reasons, in the order they are tested:
//   OVERDUE                    deadline has passed
//   DUE_WITHIN_48_HOURS        deadline within 48 hours
//   EXAM_WITHIN_4_DAYS         an exam within 96 hours
//   HIGH_WORKLOAD_PRESSURE     remaining effort >= 50% of study capacity before the deadline
//   MODERATE_WORKLOAD_PRESSURE remaining effort >= 25% of that capacity
//   DUE_WITHIN_7_DAYS          deadline within a week
//   DUE_LATER                  anything further out
//   NO_DEADLINE                no deadline recorded
export const PRIORITY_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const HOUR = 3_600_000;

export function calculatePriority({ deadline, type, remainingMinutes }, now, dailyStudyMinutes) {
  if (!deadline) return { level: "LOW", reason: "NO_DEADLINE" };
  const hoursLeft = (Date.parse(deadline) - now.getTime()) / HOUR;
  if (hoursLeft < 0) return { level: "HIGH", reason: "OVERDUE" };
  if (hoursLeft <= 48) return { level: "HIGH", reason: "DUE_WITHIN_48_HOURS" };
  if (type === "EXAM" && hoursLeft <= 96) return { level: "HIGH", reason: "EXAM_WITHIN_4_DAYS" };
  if (remainingMinutes !== null && remainingMinutes > 0) {
    const capacity = Math.max(1, hoursLeft / 24) * dailyStudyMinutes;
    const pressure = remainingMinutes / capacity;
    if (pressure >= 0.5) return { level: "HIGH", reason: "HIGH_WORKLOAD_PRESSURE" };
    if (pressure >= 0.25) return { level: "MEDIUM", reason: "MODERATE_WORKLOAD_PRESSURE" };
  }
  if (hoursLeft <= 168) return { level: "MEDIUM", reason: "DUE_WITHIN_7_DAYS" };
  return { level: "LOW", reason: "DUE_LATER" };
}
