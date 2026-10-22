import { ModelInfo } from "../types.js";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";


export const OPENAI_MODELS: ModelInfo[] = [
  {
    id: "gpt-6-sol",
    name: "GPT-6 Sol",
    baseUrl: OPENAI_BASE_URL,
    provider: "openai",
    input: ["text"],
    reasoning: true,
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  },
  {
    id: "gpt-5-2025-08-07",
    name: "GPT-5",
    baseUrl: OPENAI_BASE_URL,
    provider: "openai",
    input: ["text"],
    reasoning: true,
    contextWindow: 400_000,
    maxTokens: 128_000,
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }, //no detail of cache write
  },
  {
    id: "gpt-4o-mini-2024-07-18",
    name: "GPT-4o mini",
    baseUrl: OPENAI_BASE_URL,
    provider: "openai",
    input: ["text"],
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
  },
  
];


