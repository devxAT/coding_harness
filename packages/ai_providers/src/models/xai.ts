import { ModelInfo } from "../types.js";

export const XAI_BASE_URL = "https://api.x.ai/v1";

// TODO: verify ids and prices against xAI's current model list
export const XAI_MODELS: ModelInfo[] = [
  {
    id: "grok-2-1212",
    name: "Grok 2 (Dec 2024)",
    baseUrl: XAI_BASE_URL,
    provider: "xai",
    input: ["text"],
    reasoning: false,
    contextWindow: 131_072,
    maxTokens: 131_072,
    cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "grok-2-vision-1212",
    name: "Grok 2 Vision (Dec 2024)",
    baseUrl: XAI_BASE_URL,
    provider: "xai",
    input: ["text", "image"],
    reasoning: false,
    contextWindow: 32_768,
    maxTokens: 32_768,
    cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "grok-3",
    name: "Grok 3",
    baseUrl: XAI_BASE_URL,
    provider: "xai",
    input: ["text"],
    reasoning: false,
    contextWindow: 131_072,
    maxTokens: 131_072,
    cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "grok-3-mini",
    name: "Grok 3 Mini",
    baseUrl: XAI_BASE_URL,
    provider: "xai",
    input: ["text"],
    // grok-3-mini supports reasoning_effort but we disable it at the compat layer
    // for xai endpoints; per-model overrides can re-enable it.
    reasoning: true,
    contextWindow: 131_072,
    maxTokens: 131_072,
    cost: { input: 0.3, output: 0.5, cacheRead: 0, cacheWrite: 0 },
  },
];
