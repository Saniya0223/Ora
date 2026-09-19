import assert from "node:assert/strict";
import test from "node:test";
import { resolveDeadlineText } from "../lib/relative-date.js";

// Posted Saturday 19 Sep 2026, 12:08 in Kolkata.
const posted = Date.parse("2026-09-19T12:08:00+05:30");
const zone = "Asia/Kolkata";
const at = (text, anchor = posted) => {
  const value = resolveDeadlineText(text, anchor, zone);
  return value && `${value.date}T${value.time}`;
};

test("relative days resolve from the posting time, never the processing time", () => {
  // The critical case: processed the next morning, still the 20th.
  assert.equal(at("tomorrow 6 PM"), "2026-09-20T18:00");
  assert.equal(at("by tomorrow 6 pm"), "2026-09-20T18:00");
  assert.equal(at("6pm tomorrow"), "2026-09-20T18:00");
  assert.equal(at("tomorrow 6:30 p.m."), "2026-09-20T18:30");
  assert.equal(at("tomorrow 18:00"), "2026-09-20T18:00");
  assert.equal(at("today"), "2026-09-19T23:59");
  assert.equal(at("end of day"), "2026-09-19T23:59");
  assert.equal(at("EOD"), "2026-09-19T23:59");
  assert.equal(at("tonight"), "2026-09-19T23:59");
  assert.equal(at("tonight 9 pm"), "2026-09-19T21:00");
  assert.equal(at("day after tomorrow"), "2026-09-21T23:59");
});

test("parts of the day use the start of that part, so a deadline is never late", () => {
  assert.equal(at("tomorrow morning"), "2026-09-20T09:00");
  assert.equal(at("tomorrow afternoon"), "2026-09-20T12:00");
  assert.equal(at("tomorrow evening"), "2026-09-20T18:00");
  assert.equal(at("by noon"), "2026-09-19T12:00");
  assert.equal(at("tomorrow midnight"), "2026-09-20T23:59");
});

test("a bare clock time belongs to the posting day", () => {
  assert.equal(at("before 5 PM"), "2026-09-19T17:00");
  assert.equal(at("by 12 am"), "2026-09-19T00:00");
  assert.equal(at("by 12 pm"), "2026-09-19T12:00");
});

test("weekdays: plain and 'this' mean the coming one, 'next' never means today", () => {
  assert.equal(at("Friday"), "2026-09-25T23:59");
  assert.equal(at("this Friday"), "2026-09-25T23:59");
  assert.equal(at("by Monday 10 am"), "2026-09-21T10:00");
  assert.equal(at("Saturday"), "2026-09-19T23:59", "posted on a Saturday, 'Saturday' is that day");
  assert.equal(at("next Saturday"), "2026-09-26T23:59");
  assert.equal(at("next Monday"), "2026-09-21T23:59");
  assert.equal(at("Fri"), "2026-09-25T23:59");
  assert.equal(resolveDeadlineText("Friday", posted, zone).kind, "weekday");
  assert.equal(resolveDeadlineText("tomorrow", posted, zone).kind, "posting-day");
});

test("a day and month resolve in code, due at end of day unless a time is given", () => {
  assert.equal(at("20 September"), "2026-09-20T23:59");
  assert.equal(at("by 28 September"), "2026-09-28T23:59", "not midnight at the start of the day");
  assert.equal(at("25 Sept 5 pm"), "2026-09-25T17:00");
  assert.equal(at("September 20th"), "2026-09-20T23:59");
  assert.equal(at("1st Oct 2026 10:30"), "2026-10-01T10:30");
  assert.equal(at("5 January"), "2027-01-05T23:59", "well before posting means next year");
  assert.equal(at("15 August 2026"), "2026-08-15T23:59", "an explicit year is kept");
  assert.equal(at("10 September"), "2026-09-10T23:59", "a recent past date is not pushed a year ahead");
  assert.equal(resolveDeadlineText("20 September", posted, zone).kind, "calendar");
  for (const phrase of ["31 September", "September", "20 September tomorrow", "20 September Friday"]) {
    assert.equal(resolveDeadlineText(phrase, posted, zone), null, phrase);
  }
});

test("anything outside the grammar is left to the model or to no deadline", () => {
  for (const phrase of ["before the next lecture", "next week", "soon", "13 pm", "tomorrow Friday", "", null, "next", "20/09"]) {
    assert.equal(resolveDeadlineText(phrase, posted, zone), null, String(phrase));
  }
});

test("the posting day is the student's local day, across a UTC date line", () => {
  // 19 Sep 23:30 IST is still 19 Sep 18:00 UTC; "tomorrow" is the 20th locally.
  assert.equal(at("tomorrow 9 am", Date.parse("2026-09-19T23:30:00+05:30")), "2026-09-20T09:00");
  assert.equal(at("tomorrow 9 am", Date.parse("2026-09-20T00:30:00+05:30")), "2026-09-21T09:00");
});
