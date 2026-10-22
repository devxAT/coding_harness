import { ModelInfo } from "../types.js";

export const MISTRAL_BASE_URL = "https://api.mistral.ai/v1";

// TODO: verify ids and prices against Mistral's current model list
export const MISTRAL_MODELS: ModelInfo[] = [
  {
    id: "mistral-large-latest",
    name: "Mistral Large",
    baseUrl: MISTRAL_BASE_URL,
    provider: "mistral",
    input: ["text"],
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 8_192,
    cost: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "mistral-small-latest",
    name: "Mistral Small",
    baseUrl: MISTRAL_BASE_URL,
    provider: "mistral",
    input: ["text"],
    reasoning: false,
    contextWindow: 32_000,
    maxTokens: 8_192,
    cost: { input: 0.1, output: 0.3, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "codestral-latest",
    name: "Codestral",
    baseUrl: MISTRAL_BASE_URL,
    provider: "mistral",
    input: ["text"],
    reasoning: false,
    contextWindow: 256_000,
    maxTokens: 8_192,
    cost: { input: 0.3, output: 0.9, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "mistral-medium-latest",
    name: "Mistral Medium",
    baseUrl: MISTRAL_BASE_URL,
    provider: "mistral",
    input: ["text"],
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 8_192,
    cost: { input: 0.4, output: 2, cacheRead: 0, cacheWrite: 0 },
  },
];
