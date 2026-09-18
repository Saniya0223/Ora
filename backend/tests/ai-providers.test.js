import assert from "node:assert/strict";
import test from "node:test";
import {
  AIProviderError,
  BedrockProvider,
  GroqProvider,
  OllamaProvider,
  createAIProvider,
  isAIConfigured,
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

test("Groq extraction uses the 20B model through the OpenAI chat dialect in JSON mode", async () => {
  const calls = [];
  const provider = new GroqProvider({ apiKey: "test-key", fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(truth) } }] });
  } });
  assert.deepEqual(await provider.generateStructured({ system: "system", prompt: "prompt", maxTokens: 100 }, truthResolutionSchema), truth);
  assert.equal(calls[0].url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-key");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "openai/gpt-oss-20b");
  assert.deepEqual(body.response_format, { type: "json_object" });
  // Reasoning tokens share the completion budget, so headroom is added on top.
  assert.equal(body.max_completion_tokens, 100 + 1024);
  assert.equal(body.reasoning_effort, "low");
  assert.deepEqual(body.messages, [{ role: "system", content: "system" }, { role: "user", content: "prompt" }]);
});

test("Groq routes the reasoning tier to the 120B model without changing the default", async () => {
  const models = [];
  const provider = new GroqProvider({ apiKey: "test-key", fetchImpl: async (_url, init) => {
    models.push(JSON.parse(init.body).model);
    return jsonResponse({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(truth) } }] });
  } });
  assert.equal(provider.modelFor("extraction"), "openai/gpt-oss-20b");
  assert.equal(provider.modelFor("reasoning"), "openai/gpt-oss-120b");
  await provider.generateStructured({ system: "s", prompt: "p", maxTokens: 10, tier: "reasoning" }, truthResolutionSchema);
  await provider.generateStructured({ system: "s", prompt: "p", maxTokens: 10 }, truthResolutionSchema);
  assert.deepEqual(models, ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);

  const overridden = new GroqProvider({ apiKey: "k", extractionModel: "a", reasoningModel: "b", fetchImpl: async () => {} });
  assert.equal(overridden.modelFor("reasoning"), "b");
});

test("a Groq outage fails safely without leaking the API key", async () => {
  const provider = new GroqProvider({ apiKey: "super-secret-key", fetchImpl: async () => jsonResponse({}, 500) });
  await assert.rejects(
    () => provider.generateStructured({ system: "s", prompt: "p", maxTokens: 10 }, truthResolutionSchema),
    (error) => error instanceof AIProviderError
      && error.code === "PROVIDER_UNAVAILABLE"
      && error.unavailable
      && !JSON.stringify(error.message).includes("super-secret-key"),
  );
});

test("a truncated or malformed Groq response is rejected, not stored", async () => {
  const truncated = new GroqProvider({ apiKey: "k", fetchImpl: async () => jsonResponse({ choices: [{ finish_reason: "length", message: { content: '{"action":' } }] }) });
  await assert.rejects(
    () => truncated.generate({ system: "s", prompt: "p", maxTokens: 10 }),
    (error) => error instanceof AIProviderError && error.code === "INVALID_RESPONSE",
  );
  const garbage = new GroqProvider({ apiKey: "k", fetchImpl: async () => jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "not json" } }] }) });
  await assert.rejects(
    () => garbage.generateStructured({ system: "s", prompt: "p", maxTokens: 10 }, truthResolutionSchema),
    (error) => error instanceof AIProviderError && error.code === "INVALID_RESPONSE",
  );
});

test("Groq is the configured provider in Lambda and Ollama is never implicit", () => {
  const lambdaEnv = { AI_PROVIDER: "groq", GROQ_API_KEY: "k", AWS_LAMBDA_FUNCTION_NAME: "campusflow" };
  assert.equal(createAIProvider({ env: lambdaEnv, fetchImpl: async () => {} }).name, "groq");
  assert.equal(isAIConfigured(lambdaEnv), true);
  assert.equal(isAIConfigured({ AI_PROVIDER: "groq" }), false);

  // No AI_PROVIDER: a Groq key selects Groq, and an empty environment must not
  // silently fall back to a laptop-only Ollama endpoint.
  assert.equal(createAIProvider({ env: { GROQ_API_KEY: "k" }, fetchImpl: async () => {} }).name, "groq");
  assert.throws(
    () => createAIProvider({ env: {} }),
    (error) => error instanceof AIProviderError && error.code === "NOT_CONFIGURED",
  );
  assert.equal(isAIConfigured({}), false);
});
