import assert from "node:assert/strict";
import test from "node:test";
import { ingestNotice } from "../lib/ingestion.js";
import { standardEnv, standardTables } from "./helpers/fake-dynamo.js";

const now = new Date("2026-09-20T03:30:00.000Z");
const profile = { userId: "demo-user", name: "Maya", program: "CS", year: "3", section: "A", timezone: "Asia/Kolkata", timetableSlots: [] };
const link = (id) => `https://classroom.google.com/c/ODg1NzMyMzUyNjY5/p/${id}`;
const details = (title, deadline) => ({ title, type: "Assignment", currentDeadline: deadline, deadlineText: null, certainty: "confirmed", venue: null,
  estimatedHours: 0, actionSummary: `Do ${title}.`, instructions: [], requirements: [], topics: [], submissionMethod: null, links: [] });
const model = (...results) => ({ name: "test", async generateStructured() { return { results, ignoreReason: null }; } });
const deps = (db, ai) => ({ db, env: standardEnv, ai, tableName: "events", profileTableName: "profiles", now: () => now });
const post = (id, text, over = {}) => ({ text, sourceType: "classroom", sourceRef: `dsa:announcement:${id}`, sourceUrl: link(id),
  postedAt: "2026-09-19T06:00:00.000Z", updatedAt: "2026-09-19T06:00:00.000Z", ...over });
const only = (db) => { const events = db.all("events"); assert.equal(events.length, 1); return events[0]; };

test("a follow-up post that edits a task never takes over its Open in Classroom link", async () => {
  const db = standardTables().seed("profiles", profile);
  const created = await ingestNotice(post("first", "[Classroom] DSA: Announcement 'Submit the diagram by 24 September 2026 at 8 PM.'."),
    deps(db, model({ action: "CREATE", targetEventId: null, changeSummary: "New", eventDetails: details("Submit diagram", "2026-09-24T20:00") })));
  assert.equal(created.action, "CREATE");
  const eventId = created.event.eventId;
  assert.equal(only(db).sourceUrl, link("first"));

  // A different announcement moves the deadline: the change is recorded against that post...
  const followUp = await ingestNotice(post("second", "[Classroom] DSA: Announcement 'The diagram deadline moves to 26 September 2026 at 8 PM.'."),
    deps(db, model({ action: "UPDATE", targetEventId: eventId, changeSummary: "Moved", eventDetails: details("Submit diagram", "2026-09-26T20:00") })));
  assert.equal(followUp.action, "UPDATE");
  const afterEdit = only(db);
  assert.equal(afterEdit.currentDeadline, "2026-09-26T14:30:00.000Z");
  assert.equal(afterEdit.latestChange.sourceRef, "dsa:announcement:second", "What changed still credits the follow-up post");
  assert.equal(afterEdit.sourceUrl, link("first"), "...but the task still opens the post it came from");

  // A later post that changes nothing must not touch the link either.
  await ingestNotice(post("third", "[Classroom] DSA: Announcement 'Reminder: the diagram is due 26 September 2026 at 8 PM.'."),
    deps(db, model({ action: "UPDATE", targetEventId: eventId, changeSummary: "Reminder", eventDetails: details("Submit diagram", "2026-09-26T20:00") })));
  assert.equal(only(db).sourceUrl, link("first"));
});

test("an edit to the task's own post keeps the link current, and a missing link can still be filled", async () => {
  const db = standardTables().seed("profiles", profile);
  const created = await ingestNotice(post("own", "[Classroom] DSA: Announcement 'Quiz on 25 September 2026 at 10 AM.'."),
    deps(db, model({ action: "CREATE", targetEventId: null, changeSummary: "New", eventDetails: details("DSA quiz", "2026-09-25T10:00") })));
  const eventId = created.event.eventId;
  const edited = post("own", "[Classroom] DSA: Announcement 'Quiz moved to 27 September 2026 at 10 AM.'.", { updatedAt: "2026-09-19T09:00:00.000Z" });
  await ingestNotice(edited, deps(db, model({ action: "UPDATE", targetEventId: eventId, changeSummary: "Moved", eventDetails: details("DSA quiz", "2026-09-27T10:00") })));
  assert.equal(only(db).sourceUrl, link("own"), "the same post's link stays");

  // An older event stored without a link takes one from the post that edits it.
  const legacy = standardTables().seed("profiles", profile).seed("events", {
    userId: "demo-user", eventId: "22222222-2222-5222-8222-222222222222", title: "Legacy task", type: "Assignment",
    currentDeadline: "2026-09-25T12:00:00.000Z", venue: null, estimatedHours: 0, status: "ACTIVE", sourceType: "classroom",
    sourceRef: "dsa:announcement:legacy", priorityScore: 0, changeHistory: [],
  });
  await ingestNotice(post("newer", "[Classroom] DSA: Announcement 'Legacy task moves to 27 September 2026 at 5 PM.'."),
    deps(legacy, model({ action: "UPDATE", targetEventId: "22222222-2222-5222-8222-222222222222", changeSummary: "Moved",
      eventDetails: details("Legacy task", "2026-09-27T17:00") })));
  assert.equal(only(legacy).sourceUrl, link("newer"), "a task with no link at all gets one");
});
