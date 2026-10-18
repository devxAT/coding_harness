import { ModelInfo } from "../types.js";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// Not sure about cache prices as google provides context caching price in which there is storage prices
// taking storage prices as cache write
export const GOOGLE_MODELS: ModelInfo[] = [
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    baseUrl: GEMINI_BASE_URL,
    provider: "google",
    input: ["text"],
    reasoning: true,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.5 },
  },
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    baseUrl: GEMINI_BASE_URL,
    provider: "google",
    input: ["text"],
    reasoning: true,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.5 },
  },
  {
    id: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash Lite",
    baseUrl: GEMINI_BASE_URL,
    provider: "google",
    input: ["text"],
    reasoning: true,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 1 },
  },
];
