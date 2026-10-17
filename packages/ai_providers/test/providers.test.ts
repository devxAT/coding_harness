import assert from "node:assert/strict";
import { z } from "zod";
import {
  buildOpenAIParams,
  detectCompatFromUrl,
  getModel,
  getModels,
  getProviders,
  GOOGLE_MODELS,
  MISTRAL_MODELS,
  ModelInfo,
  OPENAI_MODELS,
  OPENROUTER_MODELS,
  stream,
  XAI_MODELS,
} from "../src/index.js";

// Helper to run named test cases
const tests: [string, () => void | Promise<void>][] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push([name, fn]);
}

// ── 1. Model Registry Tests ──────────────────────────────────────────────────

test("registry: all 6 providers are registered", () => {
  const providers = getProviders();
  assert.ok(providers.includes("anthropic"), "missing anthropic");
  assert.ok(providers.includes("google"), "missing google");
  assert.ok(providers.includes("openai"), "missing openai");
  assert.ok(providers.includes("openrouter"), "missing openrouter");
  assert.ok(providers.includes("xai"), "missing xai");
  assert.ok(providers.includes("mistral"), "missing mistral");
});

test("registry: model lookups return valid models", () => {
  const gemini = getModel("google", "gemini-2.5-flash");
  assert.equal(gemini.id, "gemini-2.5-flash");
  assert.equal(gemini.provider, "google");
  assert.equal(gemini.reasoning, true);

  const grok = getModel("xai", "grok-3");
  assert.equal(grok.id, "grok-3");
  assert.equal(grok.provider, "xai");

  const codestral = getModel("mistral", "codestral-latest");
  assert.equal(codestral.id, "codestral-latest");
  assert.equal(codestral.provider, "mistral");

  const r1 = getModel("openrouter", "deepseek/deepseek-r1");
  assert.equal(r1.id, "deepseek/deepseek-r1");
  assert.equal(r1.provider, "openrouter");
  assert.equal(r1.reasoning, true);
});

// ── 2. Compatibility Detection Tests ─────────────────────────────────────────

test("compat: OpenAI defaults", () => {
  const model: ModelInfo = OPENAI_MODELS[0];
  const compat = detectCompatFromUrl(model);
  assert.equal(compat.supportsStore, true);
  assert.equal(compat.supportsDeveloperRole, true);
  assert.equal(compat.supportsReasoningEffort, true);
  assert.equal(compat.maxTokensField, "max_completion_tokens");
  assert.equal(compat.requiresToolResultName, false);
  assert.equal(compat.requiresMistralToolIds, false);
});

test("compat: xAI defaults", () => {
  const model: ModelInfo = XAI_MODELS[0];
  const compat = detectCompatFromUrl(model);
  assert.equal(compat.supportsStore, false, "xAI must not send store: false");
  assert.equal(compat.supportsDeveloperRole, false);
  assert.equal(compat.supportsReasoningEffort, false, "xAI must not send reasoning_effort");
  assert.equal(compat.maxTokensField, "max_tokens");
});

test("compat: Mistral defaults", () => {
  const model: ModelInfo = MISTRAL_MODELS[0];
  const compat = detectCompatFromUrl(model);
  assert.equal(compat.supportsStore, false, "Mistral rejects store: false");
  assert.equal(compat.supportsDeveloperRole, false);
  assert.equal(compat.maxTokensField, "max_tokens");
  assert.equal(compat.requiresToolResultName, true, "Mistral requires tool result name");
  assert.equal(compat.requiresMistralToolIds, true, "Mistral requires 9-char tool IDs");
});

test("compat: explicit model overrides take precedence", () => {
  const customModel: ModelInfo = {
    ...XAI_MODELS[0],
    compat: {
      supportsReasoningEffort: true,
      maxTokensField: "max_completion_tokens",
    },
  };
  const compat = detectCompatFromUrl(customModel);
  assert.equal(compat.supportsReasoningEffort, true);
  assert.equal(compat.maxTokensField, "max_completion_tokens");
  assert.equal(compat.supportsStore, false); // Inherited from URL
});

// ── 3. Mistral Payload Normalization Tests ───────────────────────────────────

test("mistral: normalizes tool IDs, empty content, and tool result names", () => {
  const model = getModel("mistral", "mistral-large-latest");
  const testTool = {
    name: "bash",
    description: "run bash",
    parameters: z.object({ command: z.string() }),
  };

  const params = buildOpenAIParams(
    model,
    {
      systemPrompt: "You are an assistant",
      messages: [
        { role: "user", content: "run ls", timestamp: 1 },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_abc-123_tool_call_longer_id", // Invalid for Mistral (has symbols & > 9 chars)
              name: "bash",
              arguments: { command: "ls" },
            },
          ],
          provider: "mistral",
          model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          errorMessage: "",
          timeStamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_abc-123_tool_call_longer_id",
          toolName: "bash",
          content: [{ type: "text", text: "file.txt" }],
          isError: false,
          timestamp: 3,
        },
      ],
      tools: [testTool],
    },
  );

  // 1. max_tokens used, NOT max_completion_tokens
  assert.equal(params.max_tokens, model.maxTokens);
  assert.equal((params as any).max_completion_tokens, undefined);

  // 2. store: false omitted
  assert.equal((params as any).store, undefined);

  // 3. System message uses role "system", not "developer"
  assert.equal(params.messages[0].role, "system");

  // 4. Assistant message uses content: "" (not null, which Mistral rejects)
  const assistantMsg = params.messages[2] as any;
  assert.equal(assistantMsg.role, "assistant");
  assert.equal(assistantMsg.content, "");

  // 5. Tool call ID normalized to 9 alphanumeric characters
  const toolCall = assistantMsg.tool_calls[0];
  assert.match(toolCall.id, /^[a-zA-Z0-9]{9}$/, "tool call ID must be exactly 9 alphanumeric chars");

  // 6. Tool result message ID matches the normalized tool call ID
  const toolResultMsg = params.messages[3] as any;
  assert.equal(toolResultMsg.role, "tool");
  assert.equal(toolResultMsg.tool_call_id, toolCall.id);
  // 7. Tool result message contains name: "bash"
  assert.equal(toolResultMsg.name, "bash");
});

// ── 4. xAI Payload Tests ─────────────────────────────────────────────────────

test("xai: omits store and reasoning_effort", () => {
  const model = getModel("xai", "grok-3-mini");
  const params = buildOpenAIParams(
    model,
    {
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    },
    { resoning: "high" },
  );

  assert.equal((params as any).store, undefined);
  assert.equal((params as any).reasoning_effort, undefined);
  assert.equal(params.max_tokens, model.maxTokens);
});

// ── 5. OpenRouter Payload Tests ──────────────────────────────────────────────

test("openrouter: formats reasoning as nested object and injects empty tools when history had tools", () => {
  const model = getModel("openrouter", "deepseek/deepseek-r1");
  const params = buildOpenAIParams(
    model,
    {
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "t1", name: "fn", arguments: {} }],
          provider: "openrouter",
          model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          errorMessage: "",
          timeStamp: 1,
        },
        { role: "user", content: "now finish", timestamp: 2 },
      ],
      tools: [], // current tools is empty
    },
    { resoning: "medium" },
  );

  // Nested reasoning
  assert.deepEqual((params as any).reasoning, { effort: "medium" });
  // Explicit tools: [] injected
  assert.deepEqual(params.tools, []);
});

// ── 6. Stream Router Tests ───────────────────────────────────────────────────

test("stream: routes to correct provider function without throwing synchronously", () => {
  const gemini = getModel("google", "gemini-2.5-flash");
  const grok = getModel("xai", "grok-3");
  const mistral = getModel("mistral", "mistral-large-latest");

  // Each should return an AssistantMessageEventStream
  const s1 = stream(gemini, { messages: [] });
  assert.ok(s1 && typeof s1[Symbol.asyncIterator] === "function");

  const s2 = stream(grok, { messages: [] });
  assert.ok(s2 && typeof s2[Symbol.asyncIterator] === "function");

  const s3 = stream(mistral, { messages: [] });
  assert.ok(s3 && typeof s3[Symbol.asyncIterator] === "function");
});

// ── Runner ───────────────────────────────────────────────────────────────────

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.stack : error}`);
  }
}

if (failed === 0) {
  console.log(`\nAll ${tests.length} provider tests passed.`);
} else {
  console.log(`\n${failed} of ${tests.length} tests failed.`);
  process.exit(1);
}
