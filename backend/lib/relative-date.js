import { addDays, localParts } from "./zone.js";

// Deterministic resolution of the relative deadline phrases common in
// Classroom posts, anchored to when the source was posted. The model copies the
// phrase into deadlineText; code, not the model, does the calendar arithmetic.
// Anything outside this small grammar (absolute dates, "before the next class")
// returns null and the caller falls back to the model's own value or to none.

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_ALIASES = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
// Filler words that carry no date meaning in a deadline phrase.
const FILLER = new Set(["by", "before", "on", "till", "until", "upto", "up", "to", "due", "at", "the", "of", "latest", "deadline", "is", "this", "coming", "o'clock", "oclock", "hrs", "hours", "ist"]);
// An implied time of day. Where a post names only a part of the day, the start
// of that part is used so a deadline is never later than the post meant.
const DAY_PARTS = { morning: "09:00", afternoon: "12:00", evening: "18:00", night: "21:00", noon: "12:00", midday: "12:00", midnight: "23:59" };
const END_OF_DAY = "23:59";

const MONTHS = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
const DAY_OF_MONTH = /^(\d{1,2})(st|nd|rd|th)?$/;

const pad = (value) => String(value).padStart(2, "0");

// "20 September", "Sept 20th", "20 Sep 2026". Without a year, the date is the
// next such day on or after two months before posting, so a December post
// saying "5 January" means next year. Returns the remaining words, or null.
function takeCalendarDate(words, anchorDate) {
  const monthAt = words.findIndex((word) => word in MONTHS && !(word === "may" && !words.some((other) => DAY_OF_MONTH.test(other))));
  if (monthAt < 0) return { words, date: null };
  const month = MONTHS[words[monthAt]];
  const before = DAY_OF_MONTH.exec(words[monthAt - 1] ?? "");
  const after = DAY_OF_MONTH.exec(words[monthAt + 1] ?? "");
  const dayIndex = before ? monthAt - 1 : after ? monthAt + 1 : -1;
  if (dayIndex < 0) return null;
  const day = Number((before ?? after)[1]);
  const yearIndex = Math.max(monthAt, dayIndex) + 1;
  const explicitYear = /^\d{4}$/.test(words[yearIndex] ?? "") ? Number(words[yearIndex]) : null;
  const anchorYear = Number(anchorDate.slice(0, 4));
  const build = (year) => `${year}-${pad(month)}-${pad(day)}`;
  const valid = (value) => new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  let date = build(explicitYear ?? anchorYear);
  if (!valid(date)) return null;
  if (!explicitYear && Date.parse(date) < Date.parse(anchorDate) - 60 * 86_400_000) date = build(anchorYear + 1);
  const used = new Set([monthAt, dayIndex, ...(explicitYear ? [yearIndex] : [])]);
  return { words: words.filter((_, index) => !used.has(index)), date };
}

function clock(hours, minutes, meridiem) {
  let hour = hours;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  }
  if (hour > 23 || minutes > 59) return null;
  return `${pad(hour)}:${pad(minutes)}`;
}

function tokens(text) {
  return text.toLowerCase()
    .replace(/(\d)\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/g, (_, digit, meridiem) => `${digit} ${meridiem.replace(/\./g, "")}`)
    .replace(/end\s+of\s+(the\s+)?day|\beod\b/g, " eod ")
    .replace(/day\s+after\s+tomorrow/g, " dayaftertomorrow ")
    .replace(/[,;!?()]|\.(?!\d)/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Returns { date: "YYYY-MM-DD", time: "HH:mm", kind } or null when the phrase
// is not fully understood. Every token must be consumed, so a phrase with an
// unknown word is never half-read. A date without a time is due at 23:59.
// kind is "weekday" when the date came from a weekday name, which other words
// in the notice can shift ("moved from Friday to Monday"); "calendar" for a
// day and month; otherwise "posting-day".
export function resolveDeadlineText(text, anchorMs, timeZone) {
  if (typeof text !== "string" || !text.trim() || !Number.isFinite(anchorMs)) return null;
  const anchor = localParts(anchorMs, timeZone);
  const calendar = takeCalendarDate(tokens(text).filter((word) => !FILLER.has(word)), anchor.date);
  if (!calendar) return null;
  const words = calendar.words;
  let date = calendar.date;
  let time = null;
  let dayPart = null;
  let next = false;
  let kind = calendar.date ? "calendar" : "posting-day";
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    const following = words[index + 1];
    if (word === "next") { next = true; continue; }
    if (word === "today" || word === "eod") {
      if (date && date !== anchor.date) return null;
      date = anchor.date;
      if (word === "eod") time = time ?? END_OF_DAY;
      continue;
    }
    if (word === "tonight") { if (date) return null; date = anchor.date; dayPart = "tonight"; continue; }
    if (["tomorrow", "tmrw", "tmr", "tomorow"].includes(word)) { if (date) return null; date = addDays(anchor.date, 1); continue; }
    if (word === "dayaftertomorrow") { if (date) return null; date = addDays(anchor.date, 2); continue; }
    const weekday = WEEKDAYS.indexOf(word) >= 0 ? WEEKDAYS.indexOf(word) : WEEKDAY_ALIASES[word];
    if (weekday !== undefined) {
      if (date) return null;
      const today = WEEKDAYS.indexOf(anchor.weekday.toLowerCase());
      let ahead = (weekday - today + 7) % 7;
      // "Friday" posted on a Friday means that day; "next Friday" never does.
      if (next && ahead === 0) ahead = 7;
      date = addDays(anchor.date, ahead);
      next = false;
      kind = "weekday";
      continue;
    }
    if (word in DAY_PARTS) { if (dayPart) return null; dayPart = word; continue; }
    const match = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(word);
    if (match) {
      if (time) return null;
      const meridiem = following === "am" || following === "pm" ? following : null;
      // A bare number is an hour only with a meridiem or a clock separator;
      // "20" alone may be a day of the month, which is out of scope here.
      if (!meridiem && match[2] === undefined) return null;
      time = clock(Number(match[1]), Number(match[2] ?? 0), meridiem);
      if (!time) return null;
      if (meridiem) index++;
      continue;
    }
    return null;
  }
  if (next) return null;
  if (!date && !time && !dayPart) return null;
  if (!time) time = dayPart === "tonight" ? END_OF_DAY : dayPart ? DAY_PARTS[dayPart] : END_OF_DAY;
  // A bare clock time ("before 5 PM") belongs to the day the post was made.
  return { date: date ?? anchor.date, time, kind };
}
