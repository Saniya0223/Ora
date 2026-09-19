import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { studentProfileSchema, planningPreferencesSchema } from "./contracts.js";
import { ApiError } from "./api.js";
import { USER_ID } from "./store.js";
import { DEFAULT_TIME_ZONE, daysBetween, isValidTimeZone, localParts } from "./zone.js";

export function defaultPreferences(env = {}) {
  const fromEnv = Number(env.DAILY_STUDY_HOURS);
  const daily = Number.isFinite(fromEnv) && fromEnv >= 1 && fromEnv <= 12 ? Math.round(fromEnv * 4) / 4 : 4;
  return { dailyStudyHours: daily, preferredStudyStart: "18:00", preferredStudyEnd: "23:00", autoScheduleStudyBlocks: true, avoidClassConflicts: true };
}

export async function loadProfile(db, tableName) {
  const result = await db.send(new GetCommand({ TableName: tableName, Key: { userId: USER_ID }, ConsistentRead: true }));
  return result.Item ? studentProfileSchema.parse(result.Item) : null;
}

export function requireProfile(profile) {
  if (!profile) throw new ApiError(409, "PROFILE_REQUIRED", "Save your student profile first.");
  return profile;
}

export const profileTimeZone = (profile) => (profile?.timezone && isValidTimeZone(profile.timezone) ? profile.timezone : DEFAULT_TIME_ZONE);
export const profilePreferences = (profile, env) => ({ ...defaultPreferences(env), ...(profile?.planning ?? {}) });

// Week 1 is the week containing semesterStartDate, counted in the student's zone.
// Returns null before the semester starts or when no start date is saved.
export function academicWeek(profile, now) {
  if (!profile?.semesterStartDate) return null;
  const today = localParts(now.getTime(), profileTimeZone(profile)).date;
  const elapsed = daysBetween(profile.semesterStartDate, today);
  return elapsed < 0 ? null : Math.floor(elapsed / 7) + 1;
}

// Never return tokens, the sync lease, or internal planner bookkeeping.
export function publicProfile(profile) {
  if (!profile) return null;
  return {
    name: profile.name, program: profile.program, year: profile.year, section: profile.section,
    semester: profile.semester ?? null,
    semesterStartDate: profile.semesterStartDate ?? null,
    timezone: profileTimeZone(profile),
    connectedCourses: profile.connectedCourses,
    timetableSlots: profile.timetableSlots,
  };
}

export function preferencesDTO(profile, env) {
  return { ...profilePreferences(profile, env), timezone: profileTimeZone(profile) };
}

export async function savePreferences(db, tableName, input, env) {
  const profile = requireProfile(await loadProfile(db, tableName));
  const { timezone, ...planning } = input;
  if (timezone !== undefined && !isValidTimeZone(timezone)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Some fields are invalid.", [{ field: "timezone", issue: "Use an IANA timezone such as Asia/Kolkata" }]);
  }
  const merged = { ...profilePreferences(profile, env), ...planning };
  const checked = planningPreferencesSchema.safeParse(merged);
  if (!checked.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "Some fields are invalid.", checked.error.issues.map((issue) => ({ field: issue.path.join("."), issue: issue.message })));
  }
  const names = { "#p": "planning" };
  const values = { ":p": checked.data };
  let update = "SET #p = :p";
  if (timezone !== undefined) { names["#tz"] = "timezone"; values[":tz"] = timezone; update += ", #tz = :tz"; }
  await db.send(new UpdateCommand({
    TableName: tableName, Key: { userId: USER_ID }, UpdateExpression: update,
    ExpressionAttributeNames: names, ExpressionAttributeValues: values, ConditionExpression: "attribute_exists(userId)",
  }));
  return { ...checked.data, timezone: timezone ?? profileTimeZone(profile) };
}
