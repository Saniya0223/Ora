import assert from "node:assert/strict";
import test from "node:test";
import { handleProfile } from "../handlers/profile.js";

const env = { STUDENT_PROFILE_TABLE: "profiles" };
const request = (method, body) => ({ requestContext: { http: { method } }, body: body === undefined ? undefined : JSON.stringify(body) });

test("profile setup preserves private Classroom credentials and never returns them", async () => {
  let item = {
    userId: "demo-user", name: "Existing", program: "CS", year: "2", section: "A",
    classroomTokens: { accessToken: "access", refreshToken: "refresh", expiresAt: 1_800_000_000_000 },
    connectedCourses: ["course-1"], timetableSlots: [],
  };
  const db = { async send(command) {
    if (command.constructor.name === "GetCommand") return { Item: structuredClone(item) };
    if (command.constructor.name === "PutCommand") { item = structuredClone(command.input.Item); return {}; }
    throw new Error(`Unexpected ${command.constructor.name}`);
  } };
  const saved = await handleProfile(request("PUT", { name: "Saniya", program: "BCA", year: "3", section: "B" }), { db, env });
  assert.equal(saved.statusCode, 200);
  assert.equal(item.classroomTokens.refreshToken, "refresh");
  assert.deepEqual(item.connectedCourses, ["course-1"]);
  assert.equal(JSON.parse(saved.body).profile.classroomTokens, undefined);
  const loaded = await handleProfile(request("GET"), { db, env });
  assert.equal(JSON.parse(loaded.body).profile.classroomTokens, undefined);
});

test("profile setup rejects incomplete values before writing", async () => {
  let writes = 0;
  const db = { async send(command) { if (command.constructor.name === "PutCommand") writes++; return { Item: undefined }; } };
  const response = await handleProfile(request("PUT", { name: "", program: "BCA", year: "3", section: "B" }), { db, env });
  assert.equal(response.statusCode, 400);
  assert.equal(writes, 0);
});
