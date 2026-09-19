const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
function load(relative) {
  const filename = path.resolve(__dirname, relative);
  const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod._compile(source, filename);
  return mod.exports;
}
const p = load("../lib/presentation.ts");
const sourcePresentation = load("../lib/source-presentation.ts");

test("Classroom links only open the trusted HTTPS host; resource links reject executable URLs", () => {
  const { safeSourceLink } = sourcePresentation;
  assert.equal(safeSourceLink("https://classroom.google.com/c/x/a/y/details", true), "https://classroom.google.com/c/x/a/y/details");
  for (const value of [null, "javascript:alert(1)", "http://classroom.google.com/c/x", "https://classroom.google.com.evil.test/x", "https://user@classroom.google.com/x"]) assert.equal(safeSourceLink(value, true), null);
  assert.equal(safeSourceLink("https://forms.gle/form"), "https://forms.gle/form");
});

test("sync messages distinguish persistent review from temporary, validation, race and rate-limit failures", () => {
  const base = { failed: 0, truncated: false };
  const { syncExplanation } = sourcePresentation;
  const review = syncExplanation({ ...base, needsReview: 1 });
  assert.match(review, /could not be matched safely/);
  assert.doesNotMatch(review, /Sync again|Retry sync/);
  assert.match(syncExplanation({ ...base, temporaryFailed: 1 }), /temporary service issue/);
  assert.match(syncExplanation({ ...base, validationFailed: 1 }), /interpreted reliably/);
  assert.match(syncExplanation({ ...base, raceSkipped: 1 }), /changed during processing/);
  assert.match(syncExplanation({ ...base, rateLimited: true }), /Wait before syncing/);
  assert.match(syncExplanation(base), /All available/);
});
test("unknown estimates stay unknown, distinct from zero", () => {
  assert.equal(p.duration(null), "Estimate pending");
  assert.equal(p.duration(0), "0 min");
  assert.equal(p.duration(190), "3 h 10 min");
});
test("canonical instants display in the student timezone across midnight", () => {
  assert.equal(p.dateKey("2026-09-21T20:30:00Z", "Asia/Kolkata"), "2026-09-22");
  assert.equal(
    p.localInput("2026-09-21T20:30:00Z", "Asia/Kolkata"),
    "2026-09-22T02:00",
  );
  assert.equal(p.monday("2026-10-01"), "2026-09-28");
  assert.equal(p.addDays("2026-12-31", 1), "2027-01-01");
});
test("focus countdown excludes pauses, uses server elapsed time, clamps at zero", () => {
  const s = { plannedMinutes: 25, elapsedSeconds: 60, isRunning: true };
  assert.equal(p.focusRemaining(s, 1000, 11000), 1430);
  assert.equal(p.focusRemaining({ ...s, isRunning: false }, 1000, 11000), 1440);
  assert.equal(p.focusRemaining(s, 1000, 9999999), 0);
});
test("partial synchronization never claims fully synced", () => {
  assert.equal(p.syncLabel("HEALTHY", "PARTIAL"), "Partially synced");
  assert.equal(p.syncLabel("NEVER_SYNCED", "NEVER_SYNCED"), "Never synced");
  assert.equal(p.syncLabel("STALE", "SUCCESS"), "Sync needed");
});
test("calendar clips overnight blocks and excludes midnight end on next day", () => {
  const blocks = [
    { id: "a", start: "2026-09-21T17:30:00Z", end: "2026-09-21T19:30:00Z" },
  ];
  assert.equal(
    p.daySegments(blocks, "2026-09-21", "Asia/Kolkata")[0].endMinute,
    1440,
  );
  assert.equal(
    p.daySegments(blocks, "2026-09-22", "Asia/Kolkata")[0].startMinute,
    0,
  );
  assert.equal(
    p.daySegments(
      [{ ...blocks[0], end: "2026-09-21T18:30:00Z" }],
      "2026-09-22",
      "Asia/Kolkata",
    ).length,
    0,
  );
});
test("overlapping blocks share columns, later non-overlapping blocks use full width", () => {
  const r = p.placeOverlaps([
    { startMinute: 60, endMinute: 180 },
    { startMinute: 90, endMinute: 120 },
    { startMinute: 180, endMinute: 210 },
  ]);
  assert.deepEqual(
    r.map((i) => [i.column, i.columns]),
    [
      [0, 2],
      [1, 2],
      [0, 1],
    ],
  );
});
const originalFetch = global.fetch;
const originalBase = process.env.NEXT_PUBLIC_API_BASE_URL;
after(() => {
  global.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL;
  else process.env.NEXT_PUBLIC_API_BASE_URL = originalBase;
});
const api = load("../lib/api.ts");
test("API uses configured origin and preserves request fields", async () => {
  process.env.NEXT_PUBLIC_API_BASE_URL = "https://api.example.test/";
  global.fetch = async (url, init) => {
    assert.equal(url, "https://api.example.test/tasks");
    assert.deepEqual(JSON.parse(init.body), {
      title: "Test",
      estimatedMinutes: null,
    });
    assert.equal(init.headers["Content-Type"], "application/json");
    return new Response('{"task":{}}', { status: 201 });
  };
  await api.request("/tasks", "POST", {
    title: "Test",
    estimatedMinutes: null,
  });
});
test("API preserves safe backend validation details", async () => {
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "SOURCE_MANAGED",
          message: "This field is managed by its academic source.",
          details: [{ field: "title", issue: "Source-owned" }],
        },
      }),
      { status: 409 },
    );
  await assert.rejects(
    api.request("/tasks/id", "PATCH", { title: "Changed" }),
    (e) => e.code === "SOURCE_MANAGED" && e.details[0].field === "title",
  );
});
test("network failures do not expose runtime internals", async () => {
  global.fetch = async () => {
    throw new Error("internal detail");
  };
  await assert.rejects(
    api.request("/tasks"),
    (e) => e.code === "NETWORK_ERROR" && !e.message.includes("internal"),
  );
});
test("signed upload puts file last and lets browser set multipart header", async () => {
  global.fetch = async (url, init) => {
    assert.equal(url, "https://storage.example.test");
    assert.equal(init.headers, undefined);
    assert.deepEqual([...init.body.keys()], ["key", "policy", "file"]);
    return new Response(null, { status: 204 });
  };
  await api.uploadFile(
    {
      url: "https://storage.example.test",
      fields: { key: "test", policy: "signed" },
    },
    new File(["test"], "test.txt", { type: "text/plain" }),
  );
});

test("resource links are named by what they point to, not a vague model label", () => {
  const { linkLabel } = sourcePresentation;
  assert.equal(linkLabel("https://docs.google.com/forms/d/e/x/viewform", "Repo links"), "Google Form");
  assert.equal(linkLabel("https://forms.gle/abc", null), "Google Form");
  assert.equal(linkLabel("https://github.com/org/repo", "link"), "GitHub repository");
  assert.equal(linkLabel("https://example.edu/syllabus", "Syllabus"), "Syllabus");
  assert.equal(linkLabel("https://example.edu/syllabus", null), "example.edu");
});

test("sync summary speaks to students and keeps raw counters out of the headline", () => {
  const { syncSummary, timeAgo } = sourcePresentation;
  const now = Date.parse("2026-09-20T10:00:00Z");
  const zero = { coursesScanned: 1, announcementsScanned: 8, courseworkScanned: 2, processed: 0, created: 0, updated: 0, cancelled: 0, ignored: 0, failed: 0, truncated: false };
  const source = (sync, health = "HEALTHY") => ({ connection: "CONNECTED", health, account: null, selectedCourses: [], sync: { status: "SUCCESS", trigger: "manual", stale: false, lastAttemptAt: null, lastFinishedAt: null, lastSuccessfulSyncAt: "2026-09-20T09:58:00Z", lastErrorCode: null, lastResult: zero, ...sync } });
  const upToDate = syncSummary(source({}), now);
  assert.equal(upToDate.title, "You're up to date");
  assert.match(upToDate.detail, /2 min ago/);
  assert.doesNotMatch(JSON.stringify(upToDate), /0 created|ignored/);
  const changed = syncSummary(source({ lastResult: { ...zero, created: 1, updated: 1 } }), now);
  assert.deepEqual(changed.changes, ["1 new task added", "1 task updated"]);
  assert.equal(syncSummary(source({ status: "SYNCING" }), now).tone, "busy");
  assert.equal(syncSummary(source({ status: "PARTIAL", lastResult: { ...zero, needsReview: 1 } }), now).title, "1 Classroom item needs review");
  assert.match(syncSummary(source({ status: "PARTIAL", lastResult: { ...zero, temporaryFailed: 2 } }), now).detail, /try again shortly/);
  assert.equal(syncSummary(source({}, "REAUTH_REQUIRED"), now).tone, "error");
  assert.equal(timeAgo("2026-09-20T09:59:40Z", now), "just now");
});

test("both Sync now buttons share one controller: one request at a time, then a refresh", async () => {
  const { createClassroomSync } = load("../lib/classroom-sync.ts");
  let posts = 0, refreshes = 0, release;
  const sync = createClassroomSync(() => { posts++; return new Promise((resolve) => { release = resolve; }); }, () => { refreshes++; }, () => "Classroom couldn't be synced.");
  const seen = [];
  sync.subscribe(() => seen.push(sync.getState().syncing));
  const first = sync.sync();
  assert.equal(sync.getState().syncing, true, "enters a visible syncing state");
  assert.equal(await sync.sync(), false, "a second click while syncing is ignored");
  assert.equal(posts, 1, "only one sync request is sent");
  release();
  assert.equal(await first, true);
  assert.equal(refreshes, 1, "sources, tasks and dashboard are refreshed afterwards");
  assert.deepEqual(seen, [true, false]);
  assert.deepEqual(sync.getState(), { syncing: false, error: "" });
});

test("a failed Classroom sync reports a calm error, re-enables the button and still refreshes", async () => {
  const { createClassroomSync } = load("../lib/classroom-sync.ts");
  let refreshes = 0;
  const sync = createClassroomSync(() => Promise.reject(new Error("GOOGLE_UNAVAILABLE")), () => { refreshes++; }, () => "Classroom couldn't be synced right now. Try again shortly.");
  assert.equal(await sync.sync(), false);
  assert.deepEqual(sync.getState(), { syncing: false, error: "Classroom couldn't be synced right now. Try again shortly." });
  assert.equal(refreshes, 1);
});

test("sync results read as student-facing outcomes", () => {
  const { syncSummary } = sourcePresentation;
  const zero = { coursesScanned: 1, announcementsScanned: 1, courseworkScanned: 0, processed: 1, created: 0, updated: 0, cancelled: 0, ignored: 0, failed: 0, truncated: false };
  const src = (result, status = "SUCCESS") => ({ connection: "CONNECTED", health: "HEALTHY", account: null, selectedCourses: [], sync: { status, trigger: "manual", stale: false, lastAttemptAt: null, lastFinishedAt: null, lastSuccessfulSyncAt: null, lastErrorCode: null, lastResult: result } });
  assert.deepEqual(syncSummary(src({ ...zero, created: 1 })).changes, ["1 new task added"]);
  assert.deepEqual(syncSummary(src({ ...zero, updated: 1 })).changes, ["1 task updated"]);
  assert.equal(syncSummary(src(zero)).title, "You're up to date");
  assert.equal(syncSummary(src({ ...zero, rateLimited: true }, "PARTIAL")).title, "Some Classroom items could not be synced");
});
