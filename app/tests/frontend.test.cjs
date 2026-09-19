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
