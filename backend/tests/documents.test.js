import assert from "node:assert/strict";
import test from "node:test";
import { extractTableText, finishDocument, prepareUpload, startDocument } from "../lib/documents.js";

const id = "758af182-6b93-4778-9628-13a1348bd324";

test("upload preparation accepts only bounded PDF posts", async () => {
  const signed = await prepareUpload({ fileName: "timetable.pdf", contentType: "application/pdf", size: 1024 }, {
    s3: {}, bucket: "uploads", signUpload: async (_client, input) => ({ url: "https://example.test", fields: input.Fields }),
  });
  assert.match(signed.s3Key, /^demo-user\/uploads\/[0-9a-f-]{36}\.pdf$/);
  assert.equal(signed.fields["Content-Type"], "application/pdf");
  await assert.rejects(() => prepareUpload({ fileName: "x", contentType: "image/png", size: 1 }, { s3: {}, bucket: "uploads" }), /Choose a PDF/);
});

test("table reconstruction preserves cell position and records low confidence", () => {
  const result = extractTableText([
    { Id: "table", BlockType: "TABLE", Page: 1, Relationships: [{ Type: "CHILD", Ids: ["one", "two"] }] },
    { Id: "one", BlockType: "CELL", RowIndex: 1, ColumnIndex: 1, Confidence: 99, Relationships: [{ Type: "CHILD", Ids: ["word1"] }] },
    { Id: "two", BlockType: "CELL", RowIndex: 1, ColumnIndex: 2, Confidence: 75, Relationships: [{ Type: "CHILD", Ids: ["word2"] }] },
    { Id: "word1", BlockType: "WORD", Text: "Monday" }, { Id: "word2", BlockType: "WORD", Text: "09:00" },
  ]);
  assert.match(result.text, /row 1, column 1.*Monday/);
  assert.match(result.lowConfidenceRows[0], /09:00/);
  assert.throws(() => extractTableText([]), /No timetable grid/);
});

test("Textract start is idempotent and never accepts an arbitrary S3 key", async () => {
  const calls = [];
  const s3 = { async send(command) {
    calls.push(command.constructor.name);
    if (command.constructor.name === "GetObjectCommand") throw Object.assign(new Error(), { name: "NoSuchKey" });
    if (command.constructor.name === "HeadObjectCommand") return { ContentType: "application/pdf", ContentLength: 100, ETag: "etag" };
    if (command.constructor.name === "GetObjectCommand") return { Body: { transformToString: async () => "%PDF-" } };
    return { ETag: "new-etag" };
  } };
  // Return the PDF signature on the second S3 GET; the first is the absent job record.
  let gets = 0;
  s3.send = async (command) => {
    if (command.constructor.name === "GetObjectCommand") { gets++; if (gets === 1) throw Object.assign(new Error(), { name: "NoSuchKey" }); return { Body: { transformToString: async () => "%PDF-" } }; }
    if (command.constructor.name === "HeadObjectCommand") return { ContentType: "application/pdf", ContentLength: 100, ETag: "etag" };
    return { ETag: "new-etag" };
  };
  const textract = { async send(command) { assert.equal(command.input.FeatureTypes[0], "TABLES"); return { JobId: "textract-job" }; } };
  const result = await startDocument({ s3Key: `demo-user/uploads/${id}.pdf`, kind: "timetable" }, { s3, textract, bucket: "uploads" });
  assert.equal(result.status, "PROCESSING");
  await assert.rejects(() => startDocument({ s3Key: "other-user/x.pdf", kind: "timetable" }, { s3, textract, bucket: "uploads" }), /uploaded through CampusFlow/);
});

test("a completed timetable job is normalized and made available for student review", async () => {
  let version = 1;
  const stored = { jobId: id, s3Key: `demo-user/uploads/${id}.pdf`, kind: "timetable", textractJobId: "textract-job", status: "PROCESSING", createdAt: "2026-09-17T00:00:00.000Z" };
  const s3 = { async send(command) {
    if (command.constructor.name === "GetObjectCommand") return { ETag: `v${version}`, Body: { transformToString: async () => JSON.stringify(stored) } };
    if (command.constructor.name === "PutObjectCommand") { Object.assign(stored, JSON.parse(command.input.Body)); version++; return { ETag: `v${version}` }; }
    throw new Error(`Unexpected ${command.constructor.name}`);
  } };
  const textract = { async send() { return { JobStatus: "SUCCEEDED", DocumentMetadata: { Pages: 1 }, Blocks: [
    { Id: "table", BlockType: "TABLE", Relationships: [{ Type: "CHILD", Ids: ["cell"] }] },
    { Id: "cell", BlockType: "CELL", RowIndex: 1, ColumnIndex: 1, Confidence: 99, Relationships: [{ Type: "CHILD", Ids: ["word"] }] },
    { Id: "word", BlockType: "WORD", Text: "Monday 09:00 DSA" },
  ] }; } };
  const bedrock = { async send() { return { stopReason: "end_turn", output: { message: { content: [{ text: JSON.stringify({ slots: [{ day: "Monday", startTime: "09:00", endTime: "10:00", subject: "DSA", type: "Lecture", room: "204" }], lowConfidenceRows: [] }) }] } } }; } };
  const result = await finishDocument(id, { s3, textract, bedrock, bucket: "uploads", modelId: "test-model" });
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.result.slots[0].subject, "DSA");
  assert.equal(stored.status, "SUCCEEDED");
});
