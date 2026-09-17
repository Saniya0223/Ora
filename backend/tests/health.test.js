import assert from "node:assert/strict";
import test from "node:test";
import { handler } from "../handlers/health.js";

test("health returns an API Gateway response without needing cloud credentials", async () => {
  const result = await handler();
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["content-type"], "application/json");
  assert.equal(result.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(result.body), { status: "ok", service: "campusflow" });
});
