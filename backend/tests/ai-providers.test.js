import assert from "node:assert/strict";
import test from "node:test";
import {
  AIProviderError,
  BedrockProvider,
  OllamaProvider,
  createAIProvider,
} from "../lib/ai-providers.js";
import { truthResolutionSchema } from "../lib/contracts.js";

const truth = {
  action: "CREATE",
  targetEventId: null,
  eventDetails: { title: "DSA assignment", type: "Assignment", currentDeadline: "2026-09-20T17:00", venue: "", estimatedHours: 3 },
  changeSummary: "New assignment",
};
const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("Ollama uses the local chat API and validates extracted JSON", async () => {
  const calls = [];
  const provider = new OllamaProvider({ fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ done: true, message: { content: `Result:\n\`\`\`json\n${JSON.stringify(truth)}\n\`\`\`` } });
  } });
  assert.deepEqual(await provider.generateStructured({ system: "system", prompt: "prompt", maxTokens: 100 }, truthResolutionSchema), truth);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, "http://localhost:11434/api/chat");
  assert.equal(body.model, "qwen3:8b");
  assert.equal(body.format, "json");
  assert.equal(body.think, false);
  assert.deepEqual(body.messages, [{ role: "system", content: "system" }, { role: "user", content: "prompt" }]);
});

test("structured generation retries malformed output once and then fails safely", async () => {
  let calls = 0;
  const repaired = new OllamaProvider({ fetchImpl: async () => {
    calls++;
    return jsonResponse({ done: true, message: { content: calls === 1 ? "not json" : JSON.stringify(truth) } });
  } });
  assert.deepEqual(await repaired.generateStructured({ system: "system", prompt: "prompt", maxTokens: 100 }, truthResolutionSchema), truth);
  assert.equal(calls, 2);

  const invalid = new OllamaProvider({ fetchImpl: async () => jsonResponse({ done: true, message: { content: "not json" } }) });
  await assert.rejects(
    () => invalid.generateStructured({ system: "system", prompt: "prompt", maxTokens: 100 }, truthResolutionSchema),
    (error) => error instanceof AIProviderError && error.code === "INVALID_RESPONSE" && !error.message.includes("not json"),
  );
});

test("Bedrock provider keeps Converse model selection in configuration", async () => {
  let command;
  const provider = new BedrockProvider({
    modelId: "configured-model",
    client: { async send(value) { command = value; return { stopReason: "end_turn", output: { message: { content: [{ text: JSON.stringify(truth) }] } } }; } },
  });
  assert.deepEqual(await provider.generateStructured({ system: "system", prompt: "prompt", maxTokens: 100 }, truthResolutionSchema), truth);
  assert.equal(command.input.modelId, "configured-model");
});

test("AWS Lambda refuses an Ollama laptop configuration", () => {
  assert.throws(
    () => createAIProvider({ env: { AI_PROVIDER: "ollama", AWS_LAMBDA_FUNCTION_NAME: "campusflow" } }),
    (error) => error instanceof AIProviderError && error.code === "UNSAFE_CONFIGURATION",
  );
  assert.equal(createAIProvider({ env: { AI_PROVIDER: "ollama", AWS_LAMBDA_FUNCTION_NAME: "local", AWS_SAM_LOCAL: "true" }, fetchImpl: async () => {} }).name, "ollama");
  assert.throws(
    () => createAIProvider({ env: { AI_PROVIDER: "auto" } }),
    (error) => error instanceof AIProviderError && error.code === "NOT_CONFIGURED",
  );
});
