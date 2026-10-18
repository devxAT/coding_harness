import { ModelInfo } from "../types.js";

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_MODELS: ModelInfo[] = [
  {
    id: "claude-fabel-5-1",
    name: "Claude Fabel 5.1",
    baseUrl: ANTHROPIC_BASE_URL,
    provider: "anthropic",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: {
      input: 10,
      output: 50,
      cacheRead: 0.25,
      cacheWrite: 12.5,
    },
  },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    baseUrl: ANTHROPIC_BASE_URL,
    provider: "anthropic",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: {
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    },
  },
  {
    id: "claude-sonnet-5",
    name: "Cluade Sonnet 5",
    baseUrl: ANTHROPIC_BASE_URL,
    provider: "anthropic",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: {
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 2.5,
    },
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    baseUrl: ANTHROPIC_BASE_URL,
    provider: "anthropic",
    input: ["text", "image"],
    /**
     * for now making this false as this doesnot support adaptive thinking and there is no
     * logic of checking compatiblity yet and settings its thinking type
     * in future compat field will be added to modelInfo which for anthropic have forceAdaptiveThinking
     * boolean field to handle thiking type
     * as of now only adaptive thiking is being used
     * and this model does not support it
     *
     * this is handled here as well as when passing the model
     * thikingEnable field will be false also, if it supports that
     */
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
    cost: {
      input: 1,
      output: 5,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    },
  },
  {
    id: "claude-3-7-sonnet-latest",
    name: "Claude 3.7 Sonnet",
    baseUrl: ANTHROPIC_BASE_URL,
    provider: "anthropic",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    },
  },
  {
    id: "claude-3-5-sonnet-latest",
    name: "Claude 3.5 Sonnet",
    baseUrl: ANTHROPIC_BASE_URL,
    provider: "anthropic",
    input: ["text", "image"],
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 8_192,
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    },
  },
  {
    id: "claude-3-5-haiku-latest",
    name: "Claude 3.5 Haiku",
    baseUrl: ANTHROPIC_BASE_URL,
    provider: "anthropic",
    input: ["text", "image"],
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 8_192,
    cost: {
      input: 0.8,
      output: 4,
      cacheRead: 0.08,
      cacheWrite: 1.0,
    },
  },
  {
    id: "claude-3-opus-latest",
    name: "Claude 3 Opus",
    baseUrl: ANTHROPIC_BASE_URL,
    provider: "anthropic",
    input: ["text", "image"],
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 4_096,
    cost: {
      input: 15,
      output: 75,
      cacheRead: 1.5,
      cacheWrite: 18.75,
    },
  },
];
