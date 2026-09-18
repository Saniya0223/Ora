import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { parseAIResponse } from "./contracts.js";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_OLLAMA_MODEL = "qwen3:8b";
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
      const text = await this.generate({ ...request, system });
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

async function fetchJSON(fetchImpl, url, init, provider, timeoutMs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        if (retryableStatus(response.status) && attempt === 0) { await sleep(150); continue; }
        throw new AIProviderError("PROVIDER_UNAVAILABLE", `${provider} returned HTTP ${response.status}.`, { provider, unavailable: true });
      }
      return await response.json();
    } catch (error) {
      if (error instanceof AIProviderError) throw error;
      if (attempt === 0) { await sleep(150); continue; }
      const timeout = error?.name === "AbortError" || error?.name === "TimeoutError";
      throw new AIProviderError(timeout ? "TIMEOUT" : "PROVIDER_UNAVAILABLE", `${provider} is unavailable.`, { provider, unavailable: true, cause: error });
    }
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
  const choice = env.AI_PROVIDER?.trim().toLowerCase();
  if (!choice) return Boolean(env.BEDROCK_MODEL_ID);
  if (choice === "ollama") return !lambdaRuntime(env);
  if (choice === "bedrock") return Boolean(env.BEDROCK_MODEL_ID);
  return false;
}

export function createAIProvider({ env = process.env, bedrock, fetchImpl = globalThis.fetch } = {}) {
  const choice = env.AI_PROVIDER?.trim().toLowerCase() || (env.BEDROCK_MODEL_ID ? "bedrock" : "ollama");
  if (choice === "ollama") {
    if (lambdaRuntime(env)) throw new AIProviderError("UNSAFE_CONFIGURATION", "AWS Lambda cannot use a laptop Ollama endpoint.", { provider: choice });
    return new OllamaProvider({ baseUrl: env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_URL, model: env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL, fetchImpl });
  }
  if (choice === "bedrock") return new BedrockProvider({ client: bedrock, modelId: env.BEDROCK_MODEL_ID });
  throw new AIProviderError("NOT_CONFIGURED", "AI_PROVIDER must be ollama or bedrock.", { provider: choice });
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
