const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

// Loads a TypeScript/TSX file; its relative imports are loaded the same way.
function load(relative) {
  const filename = path.resolve(__dirname, relative);
  const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  const base = mod.require.bind(mod);
  mod.require = (request) => {
    if (request.startsWith(".")) {
      const target = [".ts", ".tsx"].map((ext) => path.resolve(path.dirname(filename), request + ext)).find((file) => fs.existsSync(file));
      if (target) return load(path.relative(__dirname, target));
    }
    return base(request);
  };
  mod._compile(source, filename);
  return mod.exports;
}

const lib = load("../lib/review-presentation.ts");
const { timeRange } = load("../lib/presentation.ts");
const { ReviewCardView } = load("../components/review-card-view.tsx");

const OPTIONS = ["UPDATE_EXISTING_CLASS_TIME", "UPDATE_EXISTING", "CREATE_NEW_CLASS_TIME", "CREATE_NEW", "IGNORE"];
const match = (id, title) => ({ eventId: id, title, deadline: null, sourceType: "classroom", type: "Assignment", why: ["Same course", "Similar title", "No deadline yet"] });
const review = (over = {}) => ({
  id: "review-1", status: "OPEN", sourceType: "classroom", sourceFileName: null, sourceUrl: "https://classroom.google.com/c/x/p/y",
  sourceExcerpt: "Hope you completed the assignment; it will be checked in OS class and graded.", detectedTitle: "OS assignment",
  ambiguity: "The OS class is a checkpoint, not an explicit deadline.",
  reasons: ["The notice says this work will be handled in OS class.", "Your next OS class is Monday at 10:00 AM.", "No explicit deadline."],
  candidates: [match("e1", "OS Assignment 3")], suggestedDeadline: "2026-09-21T10:00", classLabel: "OS",
  recommendedAction: "UPDATE_EXISTING", options: OPTIONS, createdAt: "2026-09-20T03:30:00.000Z", updatedAt: "2026-09-20T03:30:00.000Z", ...over,
});
const render = (r, action, target, busy = false) => renderToStaticMarkup(React.createElement(ReviewCardView, {
  review: r, action, targetEventId: target, busy, formatDate: (iso) => iso, onAction() {}, onTarget() {}, onConfirm() {},
}));

test("class times read as a weekday and a 12-hour time", () => {
  assert.equal(lib.classTimeLabel("2026-09-21T10:00"), "Monday at 10:00 AM");
  assert.equal(lib.classTimeLabel("2026-09-22T14:05"), "Tuesday at 2:05 PM");
  assert.equal(lib.classTimeLabel("2026-09-21T00:30"), "Monday at 12:30 AM");
  assert.equal(lib.classTimeLabel(null), null);
  assert.equal(lib.classTimeLabel("soon"), null);
});

test("decision labels are context-aware and name the class and time only when there is one", () => {
  const withClass = { classLabel: "OS", suggestedDeadline: "2026-09-21T10:00" };
  assert.equal(lib.actionLabel(withClass, "UPDATE_EXISTING_CLASS_TIME"), "Update the existing task and use the next OS class (Monday at 10:00 AM)");
  assert.equal(lib.actionLabel(withClass, "UPDATE_EXISTING"), "Update the existing task without a deadline");
  assert.equal(lib.actionLabel(withClass, "CREATE_NEW_CLASS_TIME"), "Create a separate task and use the next OS class (Monday at 10:00 AM)");
  assert.equal(lib.actionLabel(withClass, "CREATE_NEW"), "Create a separate task without a deadline");
  assert.equal(lib.actionLabel(withClass, "USE_CLASS_TIME"), "Create a task due at the next OS class (Monday at 10:00 AM)");
  assert.equal(lib.actionLabel(withClass, "KEEP_NO_DEADLINE"), "Create a task without a deadline");
  assert.equal(lib.actionLabel(withClass, "IGNORE"), "Ignore this update");
  const plain = { classLabel: null, suggestedDeadline: null };
  assert.equal(lib.actionLabel(plain, "UPDATE_EXISTING"), "Update an existing task");
  assert.equal(lib.actionLabel(plain, "CREATE_NEW"), "Create a separate task");
  assert.equal(lib.actionLabel(plain, "CANCEL"), "Cancel the existing task");
});

test("only decisions that change an existing task need a target, and confirming is blocked without one", () => {
  for (const action of ["UPDATE_EXISTING", "UPDATE_EXISTING_CLASS_TIME", "CANCEL"]) {
    assert.equal(lib.requiresTarget(action), true, action);
    assert.equal(lib.canConfirm(action, "", false), false, `${action} without a target`);
    assert.equal(lib.canConfirm(action, "e1", false), true);
    assert.deepEqual(lib.decisionBody(action, "e1"), { action, targetEventId: "e1" });
  }
  for (const action of ["CREATE_NEW", "CREATE_NEW_CLASS_TIME", "USE_CLASS_TIME", "KEEP_NO_DEADLINE", "IGNORE"]) {
    assert.equal(lib.requiresTarget(action), false, action);
    assert.equal(lib.canConfirm(action, "", false), true);
    assert.deepEqual(lib.decisionBody(action, "e1"), { action }, "no stray target is sent");
  }
  assert.equal(lib.canConfirm("IGNORE", "e1", true), false, "not while applying");
  assert.equal(lib.defaultTarget({ candidates: [match("e1", "A"), match("e2", "B")] }), "e1");
  assert.equal(lib.defaultTarget({ candidates: [] }), "");
});

test("the possible match and why it may be related stay visible whichever decision is selected", () => {
  for (const action of OPTIONS) {
    const html = render(review(), action, "e1");
    assert.match(html, /Possible match/, action);
    assert.match(html, /OS Assignment 3/, action);
    assert.match(html, /Assignment · No deadline · Google Classroom/, action);
    assert.match(html, /Why it may be related/, action);
    for (const why of ["Same course", "Similar title", "No deadline yet"]) assert.match(html, new RegExp(why), action);
  }
});

test("the card shows the source text, what was noticed, every decision, and one recommendation", () => {
  const html = render(review(), "UPDATE_EXISTING", "e1");
  assert.match(html, /Needs your confirmation · Google Classroom/);
  assert.match(html, /The OS class is a checkpoint, not an explicit deadline\./);
  assert.match(html, /Your next OS class is Monday at 10:00 AM\./);
  assert.match(html, /Read source text/);
  assert.match(html, /it will be checked in OS class and graded/);
  assert.match(html, /Open in Classroom/);
  for (const option of OPTIONS) assert.match(html, new RegExp(`value="${option}"`));
  assert.equal((html.match(/ · Recommended/g) ?? []).length, 1, "exactly one recommended option");
  assert.match(html, /Update the existing task without a deadline · Recommended/);
  assert.match(html, /Ora recommends: update the existing task without a deadline/);
  assert.doesNotMatch(html, /role="alert"|class="message error"|Error|failed/i, "a review is a question, not an error");
});

test("several matches can be chosen between; a single match is shown without a picker", () => {
  const many = render(review({ candidates: [match("e1", "OS Assignment 3"), match("e2", "OS Lab Record")] }), "UPDATE_EXISTING", "e2");
  assert.match(many, /Possible matches/);
  assert.equal((many.match(/type="radio"/g) ?? []).length, 2);
  assert.match(many, /checked=""[^>]*\/>/);
  assert.match(many, /source-review-match chosen/);
  assert.doesNotMatch(render(review(), "UPDATE_EXISTING", "e1"), /type="radio"/);
});

test("Confirm is disabled until a needed target is chosen, and while applying", () => {
  const button = (html) => /<button[^>]*>/.exec(html)[0];
  assert.match(button(render(review(), "UPDATE_EXISTING", "")), /disabled/);
  assert.doesNotMatch(button(render(review(), "UPDATE_EXISTING", "e1")), /disabled/);
  assert.doesNotMatch(button(render(review(), "IGNORE", "")), /disabled/);
  const applying = render(review(), "IGNORE", "e1", true);
  assert.match(button(applying), /disabled/);
  assert.match(applying, /Applying…/);
});

test("a review with no matches and no class time offers plain choices", () => {
  const html = render(review({ candidates: [], suggestedDeadline: null, classLabel: null, reasons: ["No explicit deadline"], recommendedAction: "KEEP_NO_DEADLINE",
    options: ["KEEP_NO_DEADLINE", "IGNORE"], sourceType: "manual", sourceUrl: null }), "KEEP_NO_DEADLINE", "");
  assert.doesNotMatch(html, /Possible match/);
  assert.doesNotMatch(html, /Open in Classroom/);
  assert.match(html, /Needs your confirmation · Notice/);
  assert.match(html, /Create a task without a deadline · Recommended/);
});

test("planner blocks show the time once when both ends share a meridiem", () => {
  assert.equal(timeRange("2026-09-21T04:30:00.000Z", "2026-09-21T05:30:00.000Z", "Asia/Kolkata"), "10:00 – 11:00am");
  assert.equal(timeRange("2026-09-21T05:30:00.000Z", "2026-09-21T07:30:00.000Z", "Asia/Kolkata"), "11:00am – 1:00pm");
});
