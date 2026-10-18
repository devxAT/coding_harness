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
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    baseUrl: GEMINI_BASE_URL,
    provider: "google",
    input: ["text"],
    reasoning: true,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 4.5 }, //prices < 200k tokens
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    baseUrl: GEMINI_BASE_URL,
    provider: "google",
    input: ["text"],
    reasoning: true,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    cost: { input: 0.4, output: 2.5, cacheRead: 0.03, cacheWrite: 1 },
  },
  {
    id: "	gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    baseUrl: GEMINI_BASE_URL,
    provider: "google",
    input: ["text"],
    reasoning: false,
    contextWindow: 1_048_576,
    maxTokens: 8_192,
    cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 1 },
  },
];
