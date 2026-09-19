import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../handlers/ingest.js";
import { ingestNotice, noticeEventId } from "../lib/ingestion.js";

const now = () => new Date("2026-09-17T04:30:00Z");
const details = { title: "DSA assignment", type: "Assignment", currentDeadline: "2026-09-20T17:00", venue: "204", estimatedHours: 3 };
const modelResult = (action, targetEventId = null, eventDetails = details) => ({ action, targetEventId, eventDetails, changeSummary: `${action} DSA assignment` });
const request = (body, method = "POST", path = "/ingest") => ({ rawPath: path, requestContext: { http: { method } }, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function fixture() {
  const records = new Map();
  const calls = [];
  const modelCalls = [];
  let output = modelResult("CREATE");
  let failUpdate = false;
  const db = { async send(command) {
    const input = command.input;
    calls.push(command);
    if (command.constructor.name === "QueryCommand") return { Items: [...records.values()].map((item) => structuredClone(item)) };
    if (command.constructor.name === "GetCommand") {
      if (input.TableName === "profiles") return { Item: { name: "Demo Student", program: "CS", year: "3", section: "A" } };
      return { Item: records.get(input.Key.eventId) };
    }
    if (command.constructor.name === "PutCommand") {
      assert.match(input.ConditionExpression, /attribute_not_exists/);
      if (records.has(input.Item.eventId)) throw Object.assign(new Error(), { name: "ConditionalCheckFailedException" });
      records.set(input.Item.eventId, structuredClone(input.Item));
      return {};
    }
    if (command.constructor.name === "UpdateCommand") {
      const item = records.get(input.Key.eventId);
      const values = input.ExpressionAttributeValues;
      assert.match(input.ConditionExpression, /size\(changeHistory\)/);
      if (failUpdate || item?.status !== "ACTIVE" || item.changeHistory.length !== values[":historyLength"]) {
        throw Object.assign(new Error(), { name: "ConditionalCheckFailedException" });
      }
      if (values[":cancelled"]) item.status = "CANCELLED";
      else Object.assign(item, { title: values[":title"], type: values[":type"], currentDeadline: values[":deadline"], venue: values[":venue"], estimatedHours: values[":hours"], priorityScore: 0 });
      item.changeHistory.push(...values[":entry"]);
      return { Attributes: structuredClone(item) };
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  } };
  const bedrock = { async send(command) {
    modelCalls.push(command);
    return { stopReason: "end_turn", output: { message: { content: [{ text: typeof output === "string" ? output : JSON.stringify(output) }] } } };
  } };
  const env = { ACADEMIC_EVENTS_TABLE: "events", STUDENT_PROFILE_TABLE: "profiles", BEDROCK_MODEL_ID: "test-model" };
  return {
    records, calls, modelCalls, db, bedrock,
    dependencies: { db, bedrock, env, now },
    core: { db, bedrock, tableName: "events", profileTableName: "profiles", modelId: "test-model", now },
    setOutput(value) { output = value; },
    conflict() { failUpdate = true; },
  };
}

test("manual API round trip creates, updates, lists, cancels, and keeps one event", async () => {
  const f = fixture();
  let response = await handleRequest(request({ text: "New DSA assignment due 20 September 2026 at 17:00" }), f.dependencies);
  assert.equal(response.statusCode, 201);
  const original = JSON.parse(response.body).event;
  assert.equal(original.userId, "demo-user");
  assert.equal(original.currentDeadline, "2026-09-20T11:30:00.000Z");
  assert.equal(original.sourceType, "manual");
  assert.equal(original.sourceRef, null);
  f.setOutput(modelResult("UPDATE", original.eventId, { ...details, currentDeadline: "2026-09-22T17:00" }));
  response = await handleRequest(request({ text: "DSA deadline moved to 22 September 2026 at 17:00" }), f.dependencies);
  assert.equal(JSON.parse(response.body).event.eventId, original.eventId);
  assert.equal(JSON.parse(response.body).event.changeHistory.length, 2);
  response = await handleRequest(request(undefined, "GET", "/events"), f.dependencies);
  assert.equal(JSON.parse(response.body).events.length, 1);
  assert.equal(JSON.parse(response.body).events[0].currentDeadline, "2026-09-22T11:30:00.000Z");
  f.setOutput(modelResult("CANCEL", original.eventId));
  response = await handleRequest(request({ text: "DSA assignment is cancelled" }), f.dependencies);
  assert.equal(JSON.parse(response.body).event.status, "CANCELLED");
  assert.equal(JSON.parse(response.body).event.currentDeadline, "2026-09-22T11:30:00.000Z", "cancel must not restore stale model details");
  response = await handleRequest(request(undefined, "GET", "/events"), f.dependencies);
  assert.deepEqual(JSON.parse(response.body).events, []);
  assert.equal(f.records.size, 1);
});

test("replaying a CREATE notice avoids Bedrock and does not resurrect cancellation", async () => {
  const f = fixture();
  const body = { text: "DSA assignment due 20 September 2026" };
  const created = JSON.parse((await handleRequest(request(body), f.dependencies)).body).event;
  f.records.get(created.eventId).status = "CANCELLED";
  const response = await handleRequest(request(body), f.dependencies);
  assert.equal(JSON.parse(response.body).action, "IGNORE");
  assert.equal(JSON.parse(response.body).event.status, "CANCELLED");
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.records.size, 1);
});

test("repeated updates do not append duplicate history", async () => {
  const f = fixture();
  const created = JSON.parse((await handleRequest(request({ text: "Initial DSA notice" }), f.dependencies)).body).event;
  f.setOutput(modelResult("UPDATE", created.eventId, { ...details, venue: "301" }));
  await handleRequest(request({ text: "DSA moved to room 301" }), f.dependencies);
  const response = await handleRequest(request({ text: "DSA moved to room 301" }), f.dependencies);
  assert.equal(JSON.parse(response.body).action, "IGNORE");
  assert.equal(f.records.get(created.eventId).changeHistory.length, 2);
});

test("valid IGNORE leaves the database unchanged", async () => {
  const f = fixture();
  f.setOutput(modelResult("IGNORE"));
  const response = await handleRequest(request({ text: "No change to the DSA assignment" }), f.dependencies);
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).event, null);
  assert.equal(f.records.size, 0);
});

test("invalid model JSON, unknown target, and concurrent edits never mutate an event", async () => {
  const f = fixture();
  const created = JSON.parse((await handleRequest(request({ text: "Initial DSA notice" }), f.dependencies)).body).event;
  f.setOutput("```json\n{}\n```");
  assert.equal((await handleRequest(request({ text: "Malformed result" }), f.dependencies)).statusCode, 502);
  f.setOutput(modelResult("UPDATE", "unknown-event"));
  assert.equal((await handleRequest(request({ text: "Unknown target" }), f.dependencies)).statusCode, 409);
  f.setOutput(modelResult("UPDATE", created.eventId, { ...details, venue: "301" }));
  f.conflict();
  assert.equal((await handleRequest(request({ text: "Concurrent update" }), f.dependencies)).statusCode, 409);
  assert.equal(f.records.get(created.eventId).changeHistory.length, 1);
});

test("request boundary rejects empty, oversized, spoofed provenance and unconfigured PDF inputs", async () => {
  const f = fixture();
  for (const body of [{ text: " " }, { text: "x".repeat(12001) }, { text: "Valid", userId: "someone-else" }, { text: "Valid", sourceType: "classroom" }, { text: "Valid", s3Key: "key" }, null]) {
    assert.equal((await handleRequest(request(body), f.dependencies)).statusCode, 400);
  }
  assert.equal((await handleRequest(request({ s3Key: "demo-user/file.pdf" }), f.dependencies)).statusCode, 503);
  assert.equal((await handleRequest({ ...request({}), body: "{" }, f.dependencies)).statusCode, 400);
  assert.equal((await handleRequest(request({ text: "Valid" }), { ...f.dependencies, env: {} })).statusCode, 503);
  assert.equal(f.modelCalls.length, 0);
});

test("prompt supplies campus time and only projected applicability data", async () => {
  const f = fixture();
  const text = 'Notice contains "quotes" and {CURRENT_EVENTS_JSON}';
  await handleRequest(request({ text }), f.dependencies);
  const command = f.modelCalls[0].input;
  // A pasted notice is posted when it is received; both reach the metadata.
  assert.match(command.messages[0].content[0].text, /"postedAt":"2026-09-17T10:00 \(Thursday\)"/);
  assert.match(command.messages[0].content[0].text, /"processedAt":"2026-09-17T10:00 \(Thursday\)","timeZone":"Asia\/Kolkata"/);
  assert.match(command.messages[0].content[0].text, /\{CURRENT_EVENTS_JSON\}/);
  assert.match(command.messages[0].content[0].text, /\\"quotes\\"/);
  const profileRead = f.calls.find((call) => call.input.TableName === "profiles");
  assert.equal(profileRead.input.ProjectionExpression.includes("classroomTokens"), false);
  // DynamoDB rejects reserved words used bare; the test double does not, so check here.
  const bare = profileRead.input.ProjectionExpression.split(/\s*,\s*/).filter((name) => !name.startsWith("#"));
  assert.deepEqual(bare.filter((name) => ["name", "year", "section", "timezone", "status", "type", "date"].includes(name)), []);
  assert.equal(profileRead.input.ExpressionAttributeNames["#tz"], "timezone");
  assert.equal(command.system[0].text.includes("accessToken"), false);
});

test("UUID identity tolerates transport whitespace and internal ingestion preserves provenance", async () => {
  const f = fixture();
  const notice = { text: "Classroom DSA notice", sourceType: "classroom", sourceRef: "work-1" };
  assert.equal(noticeEventId(notice), noticeEventId({ ...notice, text: ` ${notice.text}\n` }));
  const result = await ingestNotice(notice, f.core);
  assert.equal(result.event.sourceType, "classroom");
  assert.equal(result.event.sourceRef, "work-1");
});

test("pagination is consumed and out-of-window duplicate candidates are refused", async () => {
  const f = fixture();
  const created = JSON.parse((await handleRequest(request({ text: "Initial" }), f.dependencies)).body).event;
  const farFuture = { ...created, currentDeadline: "2026-11-20T11:30:00Z" };
  let pages = 0;
  const baseSend = f.db.send;
  f.db.send = async (command) => {
    if (command.constructor.name === "QueryCommand") {
      pages++;
      if (!command.input.ExclusiveStartKey) return { Items: [], LastEvaluatedKey: { userId: "demo-user", eventId: "cursor" } };
      return { Items: [farFuture] };
    }
    return baseSend(command);
  };
  const response = await handleRequest(request({ text: "Possibly revised distant deadline" }), f.dependencies);
  assert.equal(response.statusCode, 409);
  assert.equal(pages, 2);
});
