// Live evaluation of Truth Resolution v2 against the real extraction model.
// Runs the realistic Classroom matrix through the full ingestion pipeline with
// an in-memory database: nothing in AWS is read or written. Needs GROQ_API_KEY.
// Paced for Groq's free tier; prints only actions, dates, and token counts.
import { GroqProvider } from "../lib/ai-providers.js";
import { ingestNotice } from "../lib/ingestion.js";
import { standardEnv, standardTables } from "../tests/helpers/fake-dynamo.js";

if (!process.env.GROQ_API_KEY) {
  console.error("The evaluation needs GROQ_API_KEY in the environment.");
  process.exit(1);
}
// About 2,000 tokens per call against a free-tier budget of 8,000 per minute.
const PACE_MS = Number(process.env.EVAL_PACE_MS ?? 20_000);
const only = process.env.EVAL_ONLY ? new Set(process.env.EVAL_ONLY.split(",")) : null;

const usage = [];
const ai = new GroqProvider({
  apiKey: process.env.GROQ_API_KEY,
  extractionModel: process.env.GROQ_EXTRACTION_MODEL || "openai/gpt-oss-20b",
  fetchImpl: async (url, init) => {
    const response = await fetch(url, init);
    const body = await response.clone().json().catch(() => null);
    const sent = JSON.parse(init.body);
    usage.push({ status: response.status, model: sent.model, effort: sent.reasoning_effort, prompt: body?.usage?.prompt_tokens ?? null, completion: body?.usage?.completion_tokens ?? null, reasoning: body?.usage?.completion_tokens_details?.reasoning_tokens ?? null });
    return response;
  },
});

const POSTED = "2026-09-19T06:38:00.000Z"; // Sat 19 Sep, 12:08 IST
const now = new Date("2026-09-20T03:30:00.000Z"); // processed Sun 20 Sep, 09:00 IST
const ist = (local) => new Date(`${local}+05:30`).toISOString();
const QUIZ = "11111111-1111-5111-8111-111111111111";
const LECTURE = "22222222-2222-5222-8222-222222222222";
const LAB = "33333333-3333-5333-8333-333333333333";
const ASSIGNMENT = "44444444-4444-5444-8444-444444444444";
const event = (eventId, title, type, local, venue = null) => ({
  userId: "demo-user", eventId, title, type, currentDeadline: ist(local), venue, estimatedHours: 0, status: "ACTIVE",
  sourceType: "classroom", sourceRef: "c1:announcement:seed", priorityScore: 0, changeHistory: ["created"],
});
const profile = (section) => ({ userId: "demo-user", name: "Maya", program: "btech", year: "3", section, connectedCourses: ["c1"], timetableSlots: [], timezone: "Asia/Kolkata" });

function database({ section = "A", schedule = true } = {}) {
  const db = standardTables();
  if (section) db.seed("profiles", profile(section));
  if (schedule) {
    db.seed("events", event(QUIZ, "Quiz 2", "Exam", "2026-09-25T10:00"));
    db.seed("events", event(LECTURE, "DSA Lecture", "Lecture", "2026-09-20T10:00"));
    db.seed("events", event(LAB, "CN Lab", "Lab", "2026-09-22T14:00", "Lab 1"));
    db.seed("events", event(ASSIGNMENT, "Assignment 2", "Assignment", "2026-09-25T23:59"));
  }
  return db;
}

const SHEET = "https://docs.google.com/spreadsheets/d/1AbC_dEf/edit";
const acts = (result) => result.results.map((entry) => entry.action);
const creates = (result) => result.results.filter((entry) => entry.action === "CREATE").map((entry) => entry.event);
const day = (iso) => iso?.slice(0, 10) ?? null;
const localDay = (iso) => (iso ? new Date(Date.parse(iso) + 5.5 * 3_600_000).toISOString().slice(0, 10) : null);
const updatedOf = (db, id) => db.get("events", { userId: "demo-user", eventId: id });

// [id, notice, database options, check(result, db) => [pass, detail]]
const cases = [
  ["1", "Fill in your team roles by tomorrow 6 PM.", {}, (r) => [acts(r).join() === "CREATE" && creates(r)[0].currentDeadline === ist("2026-09-20T18:00"), creates(r)[0]?.currentDeadline]],
  ["2", "Submit this Google Form before 5 PM.", {}, (r) => [acts(r).join() === "CREATE" && creates(r)[0].currentDeadline === ist("2026-09-19T17:00"), creates(r)[0]?.currentDeadline]],
  ["3", "Enter your project preference by tonight.", {}, (r) => [acts(r).join() === "CREATE" && localDay(creates(r)[0].currentDeadline) === "2026-09-19", creates(r)[0]?.currentDeadline]],
  ["4", "Upload your signed declaration by 20 September.", {}, (r) => [acts(r).join() === "CREATE" && localDay(creates(r)[0].currentDeadline) === "2026-09-20", creates(r)[0]?.currentDeadline]],
  ["5", "Assignment 3 due Friday.", {}, (r) => [acts(r).join() === "CREATE" && localDay(creates(r)[0].currentDeadline) === "2026-09-25", creates(r)[0]?.currentDeadline]],
  ["6", "Prepare chapters 3 and 4 for Friday's quiz.", {}, (r, db) => {
    const updatedQuiz = r.results.some((entry) => entry.action === "UPDATE" && entry.event?.eventId === QUIZ && updatedOf(db, QUIZ).details?.topics?.length);
    return [acts(r).includes("CREATE") || updatedQuiz, `${acts(r).join()} topics=${JSON.stringify((creates(r)[0] ?? updatedOf(db, QUIZ)).details?.topics ?? [])}`];
  }],
  ["7", "Read pages 50–70 before the next lecture.", {}, (r) => [acts(r).join() === "CREATE" && [null, ist("2026-09-20T10:00")].includes(creates(r)[0].currentDeadline), `${acts(r).join() || "IGNORE"} ${r.reason ?? ""} ${r.modelIgnoreReason ?? ""} deadline=${creates(r)[0]?.currentDeadline ?? "none"}`]],
  ["8", "Quiz moved from Friday to Monday.", {}, (r, db) => {
    const moved = updatedOf(db, QUIZ).currentDeadline;
    return [acts(r).join() === "UPDATE" && ["2026-09-21", "2026-09-28"].includes(localDay(moved)), moved];
  }],
  ["9", "Tomorrow's lecture is cancelled.", {}, (r, db) => [acts(r).join() === "CANCEL" && updatedOf(db, LECTURE).status === "CANCELLED", updatedOf(db, LECTURE).status]],
  ["10", "Lab venue changed to LT-3.", {}, (r, db) => [acts(r).join() === "UPDATE" && updatedOf(db, LAB).venue === "LT-3" && updatedOf(db, LAB).currentDeadline === ist("2026-09-22T14:00"), `${updatedOf(db, LAB).venue} ${updatedOf(db, LAB).currentDeadline}`]],
  ["11", "Assignment 2 deadline extended to 28 September.", {}, (r, db) => [acts(r).join() === "UPDATE" && localDay(updatedOf(db, ASSIGNMENT).currentDeadline) === "2026-09-28", updatedOf(db, ASSIGNMENT).currentDeadline]],
  ["12", "Reminder: Assignment 2 is due Friday.", {}, (r, db) => [db.all("events").length === 4 && updatedOf(db, ASSIGNMENT).changeHistory.length === 1, `${acts(r).join() || "IGNORE"} reason=${r.reason} ${r.modelIgnoreReason ?? ""}`]],
  ["13", "Reminder: Assignment 2 is due Friday. Submit through this new link: https://forms.gle/NewSubmit123", {}, (r, db) => {
    const links = updatedOf(db, ASSIGNMENT).details?.links ?? [];
    return [acts(r).join() === "UPDATE" && links.some((link) => link.url === "https://forms.gle/NewSubmit123") && db.all("events").length === 4, `${acts(r).join()} links=${links.length}`];
  }],
  ["14", "Section A lab cancelled.", { section: "A" }, (r, db) => [acts(r).join() === "CANCEL" && updatedOf(db, LAB).status === "CANCELLED", updatedOf(db, LAB).status]],
  ["15", "Section A lab cancelled.", { section: "B" }, (r, db) => [updatedOf(db, LAB).status === "ACTIVE" && db.all("events").length === 4, `${acts(r).join() || "IGNORE"} ${r.modelIgnoreReason ?? ""}`]],
  ["16", "Section A lab cancelled.", { section: null }, (r, db) => [updatedOf(db, LAB).status === "ACTIVE" && db.all("events").length === 4, `${acts(r).join() || "IGNORE"} ${r.modelIgnoreReason ?? ""}`]],
  ["17", "Quiz 3 may be held Friday.", {}, (r) => {
    const item = creates(r)[0];
    return [!r.results.some((entry) => entry.event?.currentDeadline && entry.event.title !== "Quiz 2" && entry.action === "CREATE"), item ? `CREATE ${item.details.certainty} tentative=${item.details.tentativeDeadline}` : `${acts(r).join() || "IGNORE"} ${r.modelIgnoreReason ?? ""}`];
  }],
  ["18", "Quiz 3 will be held Friday.", {}, (r) => [acts(r).join() === "CREATE" && creates(r)[0].details.certainty === "confirmed" && localDay(creates(r)[0].currentDeadline) === "2026-09-25", creates(r)[0]?.currentDeadline]],
  ["19", "Assignment 3 due Friday. Quiz 4 is Monday. Bring your lab record tomorrow.", {}, (r) => [creates(r).length === 3, creates(r).map((entry) => `${entry.title}@${entry.currentDeadline}`).join(" | ")]],
  ["20", "Lab viva tomorrow 3 PM in Lab 2. Bring completed record and ID card.", {}, (r) => {
    const item = creates(r)[0];
    const needs = (item?.details.requirements ?? []).join(" ").toLowerCase();
    return [acts(r).join() === "CREATE" && item.currentDeadline === ist("2026-09-20T15:00") && /lab 2/i.test(item.venue ?? "") && needs.includes("record") && needs.includes("id"), `${item?.currentDeadline} venue=${item?.venue} req=${JSON.stringify(item?.details.requirements)}`];
  }],
  ["21", `Fill your role in the linked sheet by tomorrow 6 PM. Link: ${SHEET}`, {}, (r) => {
    const item = creates(r)[0];
    return [acts(r).join() === "CREATE" && item.currentDeadline === ist("2026-09-20T18:00") && item.details.links.some((link) => link.url === SHEET) && Boolean(item.details.actionSummary), `${item?.currentDeadline} links=${item?.details.links.length} action=${JSON.stringify(item?.details.actionSummary)}`];
  }],
  ["22", "Congratulations to everyone for completing the semester.", {}, (r, db) => [!r.results.some((entry) => entry.action !== "IGNORE") && db.all("events").length === 4, `${r.reason} ${r.modelIgnoreReason ?? ""}`]],
  ["23", "Results are available.", {}, (r, db) => [!r.results.some((entry) => entry.action !== "IGNORE") && db.all("events").length === 4, `${r.reason} ${r.modelIgnoreReason ?? ""}`]],
  ["24", "Welcome to the new semester.", {}, (r, db) => [!r.results.some((entry) => entry.action !== "IGNORE") && db.all("events").length === 4, `${r.reason} ${r.modelIgnoreReason ?? ""}`]],
  // The real announcement that production IGNOREd, as the sync formats it.
  ["real", `Dear Students, Fill in the role names in front of your names in your respective team by tomorrow 6 pm. Link: ${SHEET} Regards, Saurabh`, { schedule: true, posted: "2026-09-19T06:58:45.389Z" }, (r) => {
    const item = creates(r)[0];
    return [acts(r).join() === "CREATE" && item.currentDeadline === ist("2026-09-20T18:00"), `${item?.title} @ ${item?.currentDeadline} action=${JSON.stringify(item?.details.actionSummary)}`];
  }],
];

const rows = [];
for (const [id, notice, options, check] of cases) {
  if (only && !only.has(id)) continue;
  const db = database(options);
  const from = usage.length;
  let pass = false;
  let detail;
  try {
    const result = await ingestNotice({
      text: `[Classroom] DSA: Announcement '${notice}'.`, sourceType: "classroom", sourceRef: `c1:announcement:eval-${id}`,
      postedAt: options.posted ?? POSTED, updatedAt: options.posted ?? POSTED,
    }, { db, env: standardEnv, tableName: "events", profileTableName: "profiles", now: () => now, ai, log: () => {} });
    [pass, detail] = check(result, db);
  } catch (error) {
    detail = `ERROR ${error.code ?? error.name}`;
  }
  const calls = usage.slice(from);
  rows.push({ id, pass, detail, calls: calls.length, tokens: calls.reduce((sum, call) => sum + (call.prompt ?? 0) + (call.completion ?? 0), 0) });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id.padEnd(4)} ${notice.slice(0, 60).padEnd(60)} ${detail}`);
  await new Promise((resolve) => setTimeout(resolve, PACE_MS));
}

const models = [...new Set(usage.map((call) => `${call.model}/${call.effort}`))];
const statuses = usage.reduce((map, call) => ({ ...map, [call.status]: (map[call.status] ?? 0) + 1 }), {});
const perCall = usage.filter((call) => call.prompt !== null);
console.log(JSON.stringify({
  passed: rows.filter((row) => row.pass).length, total: rows.length,
  failed: rows.filter((row) => !row.pass).map((row) => row.id),
  modelCalls: usage.length, httpStatuses: statuses, modelsAndEffort: models,
  avgPromptTokens: Math.round(perCall.reduce((sum, call) => sum + call.prompt, 0) / (perCall.length || 1)),
  avgCompletionTokens: Math.round(perCall.reduce((sum, call) => sum + call.completion, 0) / (perCall.length || 1)),
  avgReasoningTokens: Math.round(perCall.reduce((sum, call) => sum + (call.reasoning ?? 0), 0) / (perCall.length || 1)),
}, null, 2));
