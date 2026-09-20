import assert from "node:assert/strict";
import test from "node:test";
import { classMention, ingestNotice, subjectMatches } from "../lib/ingestion.js";
import { decideReview } from "../lib/review-resolution.js";
import { listReviews } from "../lib/reviews.js";
import { standardEnv, standardTables } from "./helpers/fake-dynamo.js";

// 2026-09-20 is a Sunday (09:00 IST); the next OS lecture is Monday 21 September, 10:00.
const now = new Date("2026-09-20T03:30:00.000Z");
const env = { ...standardEnv, SOURCE_REVIEWS_TABLE: "reviews" };
const slot = (id, day, startTime, subject, type) => ({ id, day, startTime, endTime: `${String(Number(startTime.slice(0, 2)) + 1).padStart(2, "0")}:00`, subject, type, room: "" });
const profile = { userId: "demo-user", name: "Maya", program: "CS", year: "3", section: "A", timezone: "Asia/Kolkata",
  timetableSlots: [
    slot("11111111-1111-4111-8111-111111111111", "Monday", "09:00", "Data Structures", "Lecture"),
    slot("11111111-1111-4111-8111-111111111112", "Monday", "10:00", "Operating Systems", "Lecture"),
    slot("11111111-1111-4111-8111-111111111113", "Tuesday", "14:00", "os Lab", "Lab"),
  ] };
const EXISTING = "22222222-2222-5222-8222-222222222222";
const existing = (over = {}) => ({ userId: "demo-user", eventId: EXISTING, title: "OS assignment 3", type: "Assignment", currentDeadline: null, venue: null,
  estimatedHours: 0, status: "ACTIVE", sourceType: "classroom", sourceRef: "os:coursework:w3", priorityScore: 0, changeHistory: [], ...over });
const post = (text, over = {}) => ({ text, sourceType: "classroom", sourceRef: "os:announcement:a1", courseName: "OS",
  postedAt: "2026-09-19T06:38:00.000Z", updatedAt: "2026-09-19T06:38:00.000Z", sourceUrl: "https://classroom.google.com/c/test/a1", ...over });
const CHECKED = "Hope you completed the assignment; it will be checked in OS class and graded.";
const details = (title, deadline, over = {}) => ({ title, type: "Assignment", currentDeadline: deadline, deadlineText: null, certainty: "confirmed", venue: null,
  estimatedHours: 0, actionSummary: `Do ${title}.`, instructions: [], requirements: [], topics: [], submissionMethod: null, links: [], ...over });
const silent = { name: "test", async generateStructured() { return { results: [], ignoreReason: "informational" }; } };
const modelReturning = (...results) => ({ name: "test", async generateStructured() { return { results, ignoreReason: null }; } });
const deps = (db, ai = silent) => ({ db, env, ai, tableName: "events", profileTableName: "profiles", now: () => now });
const fresh = (...events) => { const db = standardTables().seed("profiles", profile); if (events.length) db.seed("events", ...events); return db; };
const one = async (db) => { const [review] = await listReviews(db, "reviews"); return review; };
const decide = (db, review, body) => decideReview(deps(db), review.id, body, now);
const rejects = (promise, code) => assert.rejects(promise, (error) => error.code === code);

test("subject matching understands acronyms, lecture-vs-lab, and refuses look-alikes", () => {
  for (const [reference, subject] of [["OS", "Operating Systems"], ["OS", "os Lab"], ["DSA", "Data Structures"], ["CN", "Computer Networks"], ["operating systems", "Operating Systems"]]) {
    assert.equal(subjectMatches(reference, subject), true, `${reference} ~ ${subject}`);
  }
  for (const [reference, subject] of [["OS", "Computer Networks"], ["M", "Mathematics"], ["lunch", "Operating Systems"]]) {
    assert.equal(subjectMatches(reference, subject), false, `${reference} !~ ${subject}`);
  }
  assert.deepEqual(classMention("checked in the next OS class"), { subject: "OS", explicit: true, kind: "class", phrase: "in the next OS class" });
  assert.equal(classMention("checked in OS class").explicit, false);
  assert.equal(classMention("checked during OS").subject, "OS");
  assert.equal(classMention("ready for class").subject, null);
  assert.equal(classMention("see the notice board"), null);
});

test("class-tied obligations become a confirmation with the next lecture, never a guessed deadline", async () => {
  const cases = [
    ["sir will check the assignment during OS", { courseName: "OS" }, "OS", "2026-09-21T10:00"],
    ["Please have the assignment ready for class.", { courseName: "DSA" }, "DSA", "2026-09-21T09:00"],
    [CHECKED, {}, "OS", "2026-09-21T10:00"],
  ];
  for (const [text, over, label, suggested] of cases) {
    const db = fresh();
    const result = await ingestNotice(post(text, over), deps(db));
    assert.equal(result.action, "REVIEW", text);
    assert.equal(db.all("events").length, 0, "nothing is created before the student decides");
    const review = await one(db);
    assert.equal(review.classLabel, label);
    assert.equal(review.suggestedDeadline, suggested, "the lecture, not the lab, on the real timetable names");
    assert.match(review.reasons.join(" "), /does not say "next class"/);
    assert.match(review.reasons.join(" "), /(Monday) at \d+:\d\d (AM|PM)/);
    assert.equal(review.recommendedAction, "KEEP_NO_DEADLINE");
  }
});

test("an explicit 'next lecture' is confident and uses the timetable; dated and unrelated phrases never ask", async () => {
  const explicit = fresh();
  const created = await ingestNotice(post("The project will be evaluated in the next lecture.", { courseName: "DSA" }),
    deps(explicit, modelReturning({ action: "CREATE", targetEventId: null, changeSummary: "New project", eventDetails: details("DSA project", null, { certainty: "tentative" }) })));
  assert.equal(created.action, "CREATE");
  assert.equal(explicit.all("events")[0].currentDeadline, "2026-09-21T03:30:00.000Z", "Monday 09:00 IST from the timetable");
  assert.deepEqual(await listReviews(explicit, "reviews"), []);

  const dated = fresh();
  const tomorrow = await ingestNotice(post("Bring your OS assignment tomorrow."),
    deps(dated, modelReturning({ action: "CREATE", targetEventId: null, changeSummary: "Bring assignment", eventDetails: details("Bring OS assignment", "2026-09-21T09:00") })));
  assert.equal(tomorrow.action, "CREATE");
  assert.deepEqual(await listReviews(dated, "reviews"), []);

  const lunch = fresh();
  const ignored = await ingestNotice(post("The assignment will be checked during lunch."), deps(lunch));
  assert.equal(ignored.action, "IGNORE", "a word the timetable does not know is not a class");
  assert.deepEqual(await listReviews(lunch, "reviews"), []);
});

test("the model can flag a class-tied deadline in words the patterns do not know, but cannot make it explicit", async () => {
  const db = fresh();
  const ai = modelReturning({ action: "CREATE", targetEventId: null, changeSummary: "Write-up", eventDetails: details("OS write-up", null),
    review: { ambiguity: "The write-up is due when the class meets.", reasons: ["No explicit deadline"], recommendedAction: "KEEP_NO_DEADLINE", classReference: { subject: "OS", explicit: true } } });
  const result = await ingestNotice(post("Bring your write-up when we meet for OS.", { courseName: "OS" }), deps(db, ai));
  assert.equal(result.action, "REVIEW", "the notice never says 'next', so the model's 'explicit' is not trusted");
  const review = await one(db);
  assert.equal(review.suggestedDeadline, "2026-09-21T10:00");
  assert.equal(db.all("events").length, 0);
});

test("with a matching task, the options are context-aware and updating keeps that task's title and deadline", async () => {
  const withDeadline = existing({ currentDeadline: "2026-09-25T12:00:00.000Z" });
  const db = fresh(withDeadline);
  await ingestNotice(post(CHECKED), deps(db));
  const review = await one(db);
  assert.deepEqual(review.options, ["UPDATE_EXISTING_CLASS_TIME", "UPDATE_EXISTING", "CREATE_NEW_CLASS_TIME", "CREATE_NEW", "IGNORE"]);
  assert.equal(review.recommendedAction, "UPDATE_EXISTING");
  assert.equal(review.candidates[0].title, "OS assignment 3");
  assert.deepEqual(review.candidates[0].why, ["Same course", "Similar title"]);
  const kept = await decide(db, review, { action: "UPDATE_EXISTING", targetEventId: EXISTING });
  assert.equal(kept.outcome.action, "IGNORE", "nothing about the task changes");
  const [event] = db.all("events");
  assert.equal(event.title, "OS assignment 3");
  assert.equal(event.currentDeadline, "2026-09-25T12:00:00.000Z", "a placeholder without a date never clears a known deadline");
});

test("use class time: update the existing task, or create a separate one, or create with no match", async () => {
  const update = fresh(existing());
  await ingestNotice(post(CHECKED), deps(update));
  const updated = await decide(update, await one(update), { action: "UPDATE_EXISTING_CLASS_TIME", targetEventId: EXISTING });
  assert.equal(updated.outcome.action, "UPDATE");
  assert.equal(update.all("events").length, 1);
  assert.equal(update.all("events")[0].title, "OS assignment 3", "the placeholder title does not rename the task");
  assert.equal(update.all("events")[0].currentDeadline, "2026-09-21T04:30:00.000Z");
  assert.ok(update.all("events")[0].latestChange.fields.some((field) => field.field === "currentDeadline"));

  const separate = fresh(existing());
  await ingestNotice(post(CHECKED), deps(separate));
  const created = await decide(separate, await one(separate), { action: "CREATE_NEW_CLASS_TIME" });
  assert.equal(created.outcome.action, "CREATE");
  const events = separate.all("events");
  assert.equal(events.length, 2);
  assert.equal(events.find((event) => event.eventId === EXISTING).currentDeadline, null, "the existing task is untouched");
  assert.equal(events.find((event) => event.eventId !== EXISTING).currentDeadline, "2026-09-21T04:30:00.000Z");

  const alone = fresh();
  await ingestNotice(post(CHECKED), deps(alone));
  const review = await one(alone);
  assert.deepEqual(review.options, ["USE_CLASS_TIME", "KEEP_NO_DEADLINE", "IGNORE"]);
  await decide(alone, review, { action: "USE_CLASS_TIME" });
  assert.equal(alone.all("events")[0].currentDeadline, "2026-09-21T04:30:00.000Z");
});

test("create a separate task without a deadline leaves the matching task alone", async () => {
  const db = fresh(existing({ currentDeadline: "2026-09-25T12:00:00.000Z" }));
  await ingestNotice(post(CHECKED), deps(db));
  const result = await decide(db, await one(db), { action: "CREATE_NEW" });
  assert.equal(result.outcome.action, "CREATE");
  const events = db.all("events");
  assert.equal(events.length, 2);
  assert.equal(events.find((event) => event.eventId !== EXISTING).currentDeadline, null);
  assert.equal(events.find((event) => event.eventId === EXISTING).currentDeadline, "2026-09-25T12:00:00.000Z");
});

test("ignore changes nothing, resolves the review, and clears the Classroom receipt for good", async () => {
  const db = fresh();
  await ingestNotice(post(CHECKED), deps(db));
  const review = await one(db);
  db.seed("sync", { userId: "demo-user", courseId: "os", lastSyncedAt: "1970-01-01T00:00:00.000Z", courseName: "OS",
    reviewItems: [{ sourceRef: "os:announcement:a1", revision: db.all("reviews")[0].revision, updatedAt: "2026-09-19T06:38:00.000Z", code: "NEEDS_REVIEW", sourceUrl: null, reviewId: review.id }], processedItems: [] });
  const result = await decide(db, review, { action: "IGNORE" });
  assert.equal(result.outcome, null);
  assert.equal(db.all("events").length, 0);
  assert.deepEqual(await listReviews(db, "reviews"), []);
  assert.equal(db.all("sync")[0].reviewItems.length, 0);
  assert.equal(db.all("sync")[0].processedItems[0].sourceRef, "os:announcement:a1");
  assert.equal((await ingestNotice(post(CHECKED), deps(db))).action, "IGNORE", "the same revision never asks again");
  assert.deepEqual(await listReviews(db, "reviews"), []);
  assert.equal((await decide(db, review, { action: "IGNORE" })).outcome, null, "deciding twice is harmless");
});

test("cancel a task the notice may be retracting, only when the student says so", async () => {
  const db = fresh(existing({ currentDeadline: "2026-09-25T12:00:00.000Z" }));
  const ai = modelReturning({ action: "CANCEL", targetEventId: EXISTING, changeSummary: "Assignment may be cancelled",
    review: { ambiguity: "The notice may withdraw the assignment.", reasons: ["Similar assignment"], recommendedAction: "IGNORE" } });
  const result = await ingestNotice(post("Assignment 3 might not be needed any more."), deps(db, ai));
  assert.equal(result.action, "REVIEW");
  assert.equal(db.all("events")[0].status, "ACTIVE", "not cancelled automatically");
  const review = await one(db);
  assert.deepEqual(review.options, ["CANCEL", "IGNORE"]);
  assert.equal(review.recommendedAction, "IGNORE");
  await decide(db, review, { action: "CANCEL", targetEventId: EXISTING });
  assert.equal(db.all("events")[0].status, "CANCELLED");
});

test("manual pasted text follows the same review path", async () => {
  const uncertain = fresh();
  const ai = { name: "test", async generateStructured() { return { results: [], ignoreReason: "uncertain" }; } };
  const pasted = { text: "Somebody said we may need to submit something soon.", sourceType: "manual", sourceRef: null };
  const result = await ingestNotice(pasted, deps(uncertain, ai));
  assert.equal(result.action, "REVIEW");
  const review = await one(uncertain);
  assert.equal(review.sourceType, "manual");
  assert.deepEqual(review.options, ["KEEP_NO_DEADLINE", "IGNORE"], "one way to create when nothing matches");
  await decide(uncertain, review, { action: "KEEP_NO_DEADLINE" });
  assert.equal(uncertain.all("events")[0].sourceType, "manual");
  assert.equal(uncertain.all("events")[0].currentDeadline, null);
  assert.equal((await ingestNotice(pasted, deps(uncertain, ai))).action, "IGNORE", "pasting it again does not ask again");

  const classy = fresh();
  const asked = await ingestNotice({ text: "Sir will check the assignment during OS.", sourceType: "manual", sourceRef: null }, deps(classy));
  assert.equal(asked.action, "REVIEW");
  assert.equal((await one(classy)).suggestedDeadline, "2026-09-21T10:00");
});

test("an edited source revision reopens a resolved review; the same revision does not", async () => {
  const db = fresh();
  await ingestNotice(post(CHECKED), deps(db));
  const first = await one(db);
  await decide(db, first, { action: "IGNORE" });
  assert.deepEqual(await listReviews(db, "reviews"), []);
  assert.equal((await ingestNotice(post(CHECKED), deps(db))).action, "IGNORE");
  const edited = post("Update: the assignment will be checked in OS class next week and graded.", { updatedAt: "2026-09-19T09:00:00.000Z" });
  assert.equal((await ingestNotice(edited, deps(db))).action, "REVIEW");
  const [reopened] = await listReviews(db, "reviews");
  assert.equal(reopened.id, first.id, "the same question, asked again for the new revision");
  assert.match(reopened.sourceExcerpt, /next week/);
  assert.equal(db.all("reviews").length, 1);
});

test("invalid decisions are rejected before anything changes", async () => {
  const db = fresh(existing());
  await ingestNotice(post(CHECKED), deps(db));
  const review = await one(db);
  await rejects(decide(db, review, { action: "UPDATE_EXISTING" }), "TARGET_REQUIRED");
  await rejects(decide(db, review, { action: "UPDATE_EXISTING", targetEventId: "33333333-3333-4333-8333-333333333333" }), "INVALID_TARGET");
  await rejects(decide(db, review, { action: "CANCEL", targetEventId: EXISTING }), "INVALID_DECISION");
  await rejects(decide(db, review, { action: "MERGE_EVERYTHING" }), "VALIDATION_ERROR");
  await rejects(decideReview(deps(db), "44444444-4444-4444-8444-444444444444", { action: "IGNORE" }, now), "NOT_FOUND");
  assert.equal(db.all("events").length, 1);
  assert.equal(db.all("events")[0].currentDeadline, null);
  assert.equal((await listReviews(db, "reviews")).length, 1, "the review is still open");
});
