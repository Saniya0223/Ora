import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { parseAIResponse } from "./contracts.js";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_OLLAMA_MODEL = "qwen3:8b";
const DEFAULT_GROQ_URL = "https://api.groq.com/openai/v1";
const DEFAULT_GROQ_EXTRACTION_MODEL = "openai/gpt-oss-20b";
const DEFAULT_GROQ_REASONING_MODEL = "openai/gpt-oss-120b";
// GPT-OSS spends reasoning tokens from the same completion budget, so a caller
// budget sized for the answer alone returns an empty generation and Groq
// rejects it with json_validate_failed. Reserve headroom on top of the ask.
const GROQ_REASONING_HEADROOM = 1024;
const retryableStatus = (status) => status === 408 || status === 429 || status >= 500;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const lambdaRuntime = (env) => env.AWS_SAM_LOCAL !== "true"
  && Boolean(env.AWS_LAMBDA_FUNCTION_NAME || env.AWS_EXECUTION_ENV?.startsWith("AWS_Lambda"));

export class AIProviderError extends Error {
  constructor(code, message, { provider, unavailable = false, cause } = {}) {
    super(message, { cause });
    this.name = "AIProviderError";
    this.code = code;
    this.provider = provider;
    this.unavailable = unavailable;
  }
}

// Minimal shared interface: providers return text; this base class owns the
// provider-independent JSON extraction, schema validation, and one repair retry.
export class AIProvider {
  constructor(name) { this.name = name; }
  async generate() { throw new Error("AIProvider.generate must be implemented"); }

  async generateStructured(request, schema) {
    let parseError;
    for (let attempt = 0; attempt < 2; attempt++) {
      const system = attempt === 0
        ? request.system
        : `${request.system}\nYour previous response was invalid. Return only one JSON value that exactly matches the contract in the prompt, with no commentary.`;
      let text;
      try { text = await this.generate({ ...request, system }); }
      catch (error) {
        // A provider-side rejection of malformed output gets the same single repair attempt.
        if (error instanceof AIProviderError && error.code === "INVALID_RESPONSE") { parseError = error; continue; }
        throw error;
      }
      try { return parseAIResponse(text, schema); }
      catch (error) { parseError = error; }
    }
    throw new AIProviderError("INVALID_RESPONSE", "The AI response did not match the required JSON contract.", { provider: this.name, cause: parseError });
  }
}

function bedrockUnavailable(error) {
  return ["AbortError", "AccessDeniedException", "ModelNotReadyException", "ServiceUnavailableException", "ThrottlingException", "TimeoutError", "ValidationException"].includes(error?.name)
    || error?.$metadata?.httpStatusCode >= 500;
}

export class BedrockProvider extends AIProvider {
  constructor({ client, modelId }) {
    super("bedrock");
    if (!client || !modelId) throw new AIProviderError("NOT_CONFIGURED", "Bedrock requires a client and BEDROCK_MODEL_ID.", { provider: this.name });
    this.client = client;
    this.modelId = modelId;
  }

  async generate({ system, prompt, maxTokens, temperature = 0, timeoutMs = 20_000 }) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.client.send(new ConverseCommand({
          modelId: this.modelId,
          system: [{ text: system }],
          messages: [{ role: "user", content: [{ text: prompt }] }],
          inferenceConfig: { maxTokens, temperature },
        }), { abortSignal: AbortSignal.timeout(timeoutMs) });
        const content = response.output?.message?.content;
        if (response.stopReason !== "end_turn" || !content?.length || content.some((block) => typeof block.text !== "string")) {
          throw new AIProviderError("INVALID_RESPONSE", "Bedrock returned an incomplete response.", { provider: this.name });
        }
        return content.map((block) => block.text).join("");
      } catch (error) {
        if (error instanceof AIProviderError) throw error;
        const timeout = error?.name === "AbortError" || error?.name === "TimeoutError";
        const transient = timeout || ["ModelNotReadyException", "ServiceUnavailableException", "ThrottlingException"].includes(error?.name) || error?.$metadata?.httpStatusCode >= 500;
        if (transient && attempt === 0) { await sleep(150); continue; }
        throw new AIProviderError(timeout ? "TIMEOUT" : "PROVIDER_UNAVAILABLE", "Bedrock is unavailable.", { provider: this.name, unavailable: bedrockUnavailable(error), cause: error });
      }
    }
  }
}

// Bounded rate-limit handling: a 429 waits as the provider asks (Retry-After,
// or Groq's token-reset header), else backs off exponentially, and gives up
// after a fixed number of retries and a fixed total wait. Never unbounded.
export const RATE_LIMIT_POLICY = { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 10_000, maxTotalWaitMs: 20_000 };

// "7.66s", "1m2.5s", "250ms", or a bare number of seconds.
export function parseResetDuration(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(text);
  if (!match || !match.slice(1).some(Boolean)) return null;
  const [, h = 0, m = 0, s = 0, ms = 0] = match;
  return Math.round(Number(h) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1000 + Number(ms));
}

function rateLimitDelay(response, retry, policy) {
  const header = (name) => (typeof response.headers?.get === "function" ? response.headers.get(name) : null);
  const asked = parseResetDuration(header("retry-after")) ?? parseResetDuration(header("x-ratelimit-reset-tokens"));
  return Math.min(policy.maxDelayMs, asked ?? policy.baseDelayMs * 2 ** retry);
}

async function fetchJSON(fetchImpl, url, init, provider, timeoutMs, { sleepImpl = sleep, policy = RATE_LIMIT_POLICY } = {}) {
  let transientRetried = false;
  let rateRetries = 0;
  let waited = 0;
  for (;;) {
    try {
      const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (response.status === 429) {
        const delay = rateLimitDelay(response, rateRetries, policy);
        if (rateRetries < policy.maxRetries && waited + delay <= policy.maxTotalWaitMs) {
          rateRetries++;
          waited += delay;
          await sleepImpl(delay);
          continue;
        }
        throw new AIProviderError("RATE_LIMITED", `${provider} is rate limiting requests.`, { provider, unavailable: true });
      }
      if (!response.ok) {
        // Groq's JSON mode rejects output that is not valid JSON with a 400:
        // that is a malformed answer, not an outage.
        if (response.status === 400) {
          const body = await response.json().catch(() => null);
          if (body?.error?.code === "json_validate_failed") throw new AIProviderError("INVALID_RESPONSE", `${provider} returned malformed JSON.`, { provider });
        }
        if (retryableStatus(response.status) && !transientRetried) { transientRetried = true; await sleepImpl(150); continue; }
        throw new AIProviderError("PROVIDER_UNAVAILABLE", `${provider} returned HTTP ${response.status}.`, { provider, unavailable: true });
      }
      return await response.json();
    } catch (error) {
      if (error instanceof AIProviderError) throw error;
      if (!transientRetried) { transientRetried = true; await sleepImpl(150); continue; }
      const timeout = error?.name === "AbortError" || error?.name === "TimeoutError";
      throw new AIProviderError(timeout ? "TIMEOUT" : "PROVIDER_UNAVAILABLE", `${provider} is unavailable.`, { provider, unavailable: true, cause: error });
    }
  }
}

// Groq speaks the OpenAI chat-completions dialect. Two GPT-OSS models are
// configured: the 20B model runs every Classroom extraction, and the 120B model
// is selected only by an explicit `tier: "reasoning"` request, so routine
// syncing never pays for the larger model.
export class GroqProvider extends AIProvider {
  constructor({ apiKey, extractionModel = DEFAULT_GROQ_EXTRACTION_MODEL, reasoningModel = DEFAULT_GROQ_REASONING_MODEL, reasoningEffort = "low", baseUrl = DEFAULT_GROQ_URL, fetchImpl = globalThis.fetch, sleepImpl = sleep, rateLimitPolicy = RATE_LIMIT_POLICY } = {}) {
    super("groq");
    if (!apiKey) throw new AIProviderError("NOT_CONFIGURED", "Groq requires GROQ_API_KEY.", { provider: this.name });
    if (typeof fetchImpl !== "function") throw new AIProviderError("NOT_CONFIGURED", "Groq requires fetch support.", { provider: this.name });
    this.apiKey = apiKey;
    this.extractionModel = extractionModel;
    this.reasoningModel = reasoningModel;
    this.reasoningEffort = reasoningEffort;
    this.baseUrl = baseUrl.replace(new RegExp("/+$"), "");
    this.fetchImpl = fetchImpl;
    this.retry = { sleepImpl, policy: rateLimitPolicy };
  }

  modelFor(tier) { return tier === "reasoning" ? this.reasoningModel : this.extractionModel; }

  async generate({ system, prompt, maxTokens, temperature = 0, timeoutMs = 20_000, tier = "extraction" }) {
    const result = await fetchJSON(this.fetchImpl, `${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.modelFor(tier),
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
        temperature,
        max_completion_tokens: maxTokens + GROQ_REASONING_HEADROOM,
        reasoning_effort: this.reasoningEffort,
        response_format: { type: "json_object" },
        stream: false,
      }),
    }, this.name, timeoutMs, this.retry);
    const choice = result.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== "string" || !content.trim() || choice.finish_reason === "length") {
      throw new AIProviderError("INVALID_RESPONSE", "Groq returned an incomplete response.", { provider: this.name });
    }
    return content;
  }
}

export class OllamaProvider extends AIProvider {
  constructor({ baseUrl = DEFAULT_OLLAMA_URL, model = DEFAULT_OLLAMA_MODEL, fetchImpl = globalThis.fetch } = {}) {
    super("ollama");
    if (typeof fetchImpl !== "function") throw new AIProviderError("NOT_CONFIGURED", "Ollama requires fetch support.", { provider: this.name });
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.fetchImpl = fetchImpl;
  }

  async generate({ system, prompt, maxTokens, temperature = 0, timeoutMs = 120_000 }) {
    const result = await fetchJSON(this.fetchImpl, `${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
        stream: false,
        format: "json",
        think: false,
        options: { temperature, num_predict: maxTokens },
      }),
    }, this.name, timeoutMs);
    if (result.done !== true || typeof result.message?.content !== "string" || !result.message.content.trim()) {
      throw new AIProviderError("INVALID_RESPONSE", "Ollama returned an incomplete response.", { provider: this.name });
    }
    return result.message.content;
  }
}

export function isAIConfigured(env = process.env) {
  const choice = env.AI_PROVIDER?.trim().toLowerCase() || implicitChoice(env);
  if (choice === "groq") return Boolean(env.GROQ_API_KEY);
  if (choice === "ollama") return !lambdaRuntime(env);
  if (choice === "bedrock") return Boolean(env.BEDROCK_MODEL_ID);
  return false;
}

// Ollama is never chosen implicitly: it is a laptop-only provider, so falling
// back to it silently would make a misconfigured deployment look healthy.
function implicitChoice(env) {
  if (env.GROQ_API_KEY) return "groq";
  if (env.BEDROCK_MODEL_ID) return "bedrock";
  return "";
}

export function createAIProvider({ env = process.env, bedrock, fetchImpl = globalThis.fetch } = {}) {
  const choice = env.AI_PROVIDER?.trim().toLowerCase() || implicitChoice(env);
  if (choice === "groq") {
    return new GroqProvider({
      apiKey: env.GROQ_API_KEY,
      extractionModel: env.GROQ_EXTRACTION_MODEL || DEFAULT_GROQ_EXTRACTION_MODEL,
      reasoningModel: env.GROQ_REASONING_MODEL || DEFAULT_GROQ_REASONING_MODEL,
      reasoningEffort: env.GROQ_REASONING_EFFORT || "low",
      baseUrl: env.GROQ_BASE_URL || DEFAULT_GROQ_URL,
      fetchImpl,
    });
  }
  if (choice === "ollama") {
    if (lambdaRuntime(env)) throw new AIProviderError("UNSAFE_CONFIGURATION", "AWS Lambda cannot use a laptop Ollama endpoint.", { provider: choice });
    return new OllamaProvider({ baseUrl: env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_URL, model: env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL, fetchImpl });
  }
  if (choice === "bedrock") return new BedrockProvider({ client: bedrock, modelId: env.BEDROCK_MODEL_ID });
  throw new AIProviderError("NOT_CONFIGURED", "AI_PROVIDER must be groq, bedrock, or ollama.", { provider: choice });
}

export function providerFrom(dependencies = {}) {
  if (dependencies.ai) return dependencies.ai;
  // Legacy callers that inject a Bedrock client/model are explicit dependency
  // injection and must remain isolated from the developer's shell variables.
  const sourceEnv = dependencies.env ?? (dependencies.bedrock && dependencies.modelId ? {} : process.env);
  const env = { ...sourceEnv };
  if (!env.BEDROCK_MODEL_ID && dependencies.modelId) env.BEDROCK_MODEL_ID = dependencies.modelId;
  return createAIProvider({ env, bedrock: dependencies.bedrock, fetchImpl: dependencies.fetchImpl });
}
