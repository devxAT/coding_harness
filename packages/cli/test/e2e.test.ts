/**
 * End-to-end checks with a scripted fake provider (no network, no API key).
 * Run: npm test --workspace @coding-harness/cli   (needs `npm run build` first)
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { z } from "zod";
import {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  getModel,
  StreamOptions,
  ToolCall,
} from "@coding-harness/ai-providers";
import {
  Agent,
  AgentEvent,
  AgentMessage,
  AgentTool,
  buildSystemPrompt,
  createCodingTools,
  streamFn,
} from "@coding-harness/agent";
import { Repl } from "../src/repl.js";
import { findModel, getAllModels } from "../src/model-selector.js";

// ---- fake provider ---------------------------------------------------------

type Block = { text: string } | ToolCall;

function assistantMessage(
  blocks: Block[],
  opts: { totalTokens?: number; stopReason?: AssistantMessage["stopReason"]; errorMessage?: string } = {},
): AssistantMessage {
  const hasTool = blocks.some((b) => "name" in b);
  return {
    role: "assistant",
    content: blocks.map((b) => ("name" in b ? b : { type: "text" as const, text: b.text })),
    provider: "anthropic",
    model: "fake",
    usage: {
      input: opts.totalTokens ?? 10,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: opts.totalTokens ?? 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: opts.stopReason ?? (hasTool ? "toolUse" : "stop"),
    errorMessage: opts.errorMessage ?? "",
    timeStamp: Date.now(),
  };
}

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

type Script = (ctx: Context, options: StreamOptions | undefined) => AssistantMessage | Promise<AssistantMessage>;

function fakeStream(script: Script, seen: Context[] = []): streamFn {
  return (_model, context, options) => {
    seen.push(structuredClone({ ...context, tools: undefined }));
    const stream = new AssistantMessageEventStream();
    void (async () => {
      const aborted = new Promise<never>((_, reject) =>
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
      try {
        const msg = await Promise.race([Promise.resolve(script(context, options)), aborted]);
        stream.push({ type: "start", partial: { ...msg, content: [] } });
        msg.content.forEach((block, i) => {
          if (block.type === "text") {
            stream.push({ type: "text_start", contentIndex: i, partial: msg });
            stream.push({ type: "text_delta", contentIndex: i, delta: block.text, partial: msg });
            stream.push({ type: "text_end", contentIndex: i, content: block.text, partial: msg });
          } else if (block.type === "toolCall") {
            stream.push({ type: "toolcall_start", contentIndex: i, partial: msg });
            stream.push({ type: "toolcall_end", contentIndex: i, toolCall: block, partial: msg });
          }
        });
        if (msg.stopReason === "error") stream.push({ type: "error", reason: "error", error: msg });
        else stream.push({ type: "done", reason: msg.stopReason as "stop" | "toolUse" | "length", message: msg });
      } catch {
        const msg = assistantMessage([], { stopReason: "aborted", errorMessage: "aborted" });
        stream.push({ type: "error", reason: "aborted", error: msg });
      }
      stream.end();
    })();
    return stream;
  };
}

const smallModel = { ...getModel("anthropic", "claude-haiku-4-5-20251001"), contextWindow: 1000 };

function lastUserText(ctx: Context): string {
  const m = [...ctx.messages].reverse().find((x) => x.role === "user");
  if (!m) return "";
  return typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

function newAgent(script: Script, tools: AgentTool<any>[], seen: Context[] = []): Agent {
  return new Agent({
    initialState: { model: smallModel, systemPrompt: "sys", tools },
    streamFn: fakeStream(script, seen),
    getApiKey: () => "test-key",
  });
}

// ---- tiny runner -----------------------------------------------------------

const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

// ---- tests -----------------------------------------------------------------

test("loop: write tool call, then final answer, in the right event order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ch-"));
  try {
    let turn = 0;
    const agent = newAgent(
      () =>
        turn++ === 0
          ? assistantMessage([call("c1", "write", { path: "out/a.txt", content: "hello" })])
          : assistantMessage([{ text: "done" }]),
      createCodingTools(dir),
    );
    const events: string[] = [];
    agent.subscribe((e: AgentEvent) => events.push(e.type));

    await agent.prompt("make a file");

    assert.equal(readFileSync(join(dir, "out", "a.txt"), "utf-8"), "hello");
    assert.deepEqual(agent.state.messages.map((m) => m.role), ["user", "assistant", "toolResult", "assistant"]);
    const order = events.filter((e) => ["agent_start", "tool_execution_start", "tool_execution_end", "agent_end"].includes(e));
    assert.deepEqual(order, ["agent_start", "tool_execution_start", "tool_execution_end", "agent_end"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loop: unknown tool and bad arguments become isError results, run continues", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ch-"));
  try {
    let turn = 0;
    const agent = newAgent(
      () =>
        turn++ === 0
          ? assistantMessage([call("c1", "nope", {}), call("c2", "write", { path: 5 })])
          : assistantMessage([{ text: "ok" }]),
      createCodingTools(dir),
    );
    await agent.prompt("go");
    const results = agent.state.messages.filter((m) => m.role === "toolResult");
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.role === "toolResult" && r.isError));
    assert.equal(agent.state.messages.at(-1)?.role, "assistant");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("steering: queued message skips remaining tool calls and lands on the next turn", async () => {
  const ran: string[] = [];
  let agent!: Agent;
  const mk = (name: string): AgentTool<any> => ({
    name,
    label: name,
    description: name,
    parameters: z.object({}),
    execute: async () => {
      ran.push(name);
      if (name === "first") agent.steer({ role: "user", content: [{ type: "text", text: "change of plan" }], timestamp: Date.now() });
      return { content: [{ type: "text", text: name }] };
    },
  });
  const seen: Context[] = [];
  let turn = 0;
  agent = newAgent(
    (ctx) =>
      turn++ === 0
        ? assistantMessage([call("c1", "first", {}), call("c2", "second", {})])
        : assistantMessage([{ text: `saw: ${lastUserText(ctx)}` }]),
    [mk("first"), mk("second")],
    seen,
  );
  await agent.prompt("start");

  assert.deepEqual(ran, ["first"]);
  const results = agent.state.messages.filter((m) => m.role === "toolResult");
  assert.equal(results.length, 2);
  assert.ok(results[1].role === "toolResult" && results[1].isError);
  const final = agent.state.messages.at(-1);
  assert.ok(final?.role === "assistant" && final.content[0].type === "text" && final.content[0].text === "saw: change of plan");
});

test("abort: agent.abort() stops a hanging request and leaves valid history", async () => {
  const agent = newAgent(() => new Promise<AssistantMessage>(() => {}), []);
  const run = agent.prompt("hang");
  setTimeout(() => agent.abort(), 20);
  await run;
  assert.equal(agent.state.isStreaming, false);
  const last = agent.state.messages.at(-1);
  assert.ok(last?.role === "assistant" && last.stopReason === "aborted");
  // the agent can be used again
  await assert.doesNotReject(agent.continue().catch((e) => { if (!/assistant/.test(String(e))) throw e; }));
});

test("model-selector: findModel finds models by provider/id and shorthand", () => {
  const m1 = findModel("google/gemini-2.5-flash");
  assert.ok(m1, "finds by provider/id");
  assert.equal(m1.id, "gemini-2.5-flash");
  assert.equal(m1.provider, "google");

  const m2 = findModel("gemini-2.5-flash");
  assert.ok(m2, "finds by short id");
  assert.equal(m2.id, "gemini-2.5-flash");

  const m3 = findModel("anthropic/claude-haiku-4-5-20251001");
  assert.ok(m3, "finds anthropic model");
  assert.equal(m3.provider, "anthropic");

  const m4 = findModel("openai/gpt-4o");
  assert.ok(m4, "finds openai model");
  assert.equal(m4.provider, "openai");

  const m5 = findModel("nonexistent-model-xyz");
  assert.equal(m5, undefined, "returns undefined for unknown");
});

test("model-selector: getAllModels returns models across all providers", () => {
  const models = getAllModels((p) => (p === "anthropic" ? "test-key" : undefined));
  assert.ok(models.length >= 10, "returns all registered models");
  const anthropicModel = models.find((m) => m.provider === "anthropic");
  assert.ok(anthropicModel?.hasApiKey, "flags key as present for anthropic");
  const openaiModel = models.find((m) => m.provider === "openai");
  assert.equal(openaiModel?.hasApiKey, false, "flags key as missing for openai");
});

test("repl: /model switches active model directly", async () => {
  const agent = newAgent(() => assistantMessage([{ text: "ok" }]), []);
  const input = new PassThrough();
  const output = new PassThrough();
  let out = "";
  output.on("data", (d) => (out += d.toString()));

  const repl = new Repl({ agent, getApiKey: () => "test-key", input, output });
  const finished = repl.start();

  input.write("/model google/gemini-2.5-flash\n");
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(agent.state.model?.id, "gemini-2.5-flash");
  assert.equal(agent.state.model?.provider, "google");
  assert.match(out, /model switched to google\/gemini-2\.5-flash/);

  input.write("/exit\n");
  await finished;
});

test("repl: starts with no model, refuses prompts until one is selected", async () => {
  let calls = 0;
  const agent = new Agent({
    initialState: { systemPrompt: "sys", tools: [] },
    streamFn: fakeStream(() => {
      calls++;
      return assistantMessage([{ text: "hi there" }]);
    }),
    getApiKey: () => "test-key",
  });
  assert.equal(agent.state.model, undefined);

  const input = new PassThrough();
  const output = new PassThrough();
  let out = "";
  output.on("data", (d) => (out += d.toString()));

  const repl = new Repl({ agent, getApiKey: () => "test-key", input, output });
  const finished = repl.start();
  assert.match(out, /No model selected/);

  input.write("hello\n");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 0);
  assert.equal(agent.state.messages.length, 0);

  input.write("/model anthropic/claude-haiku-4-5-20251001\n");
  input.write("hello\n");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls, 1);
  assert.match(out, /hi there/);

  input.write("/exit\n");
  await finished;
});

test("repl: /models lists models in non-interactive environment", async () => {
  const agent = newAgent(() => assistantMessage([{ text: "ok" }]), []);
  const input = new PassThrough();
  const output = new PassThrough();
  let out = "";
  output.on("data", (d) => (out += d.toString()));

  const repl = new Repl({ agent, getApiKey: () => "test-key", input, output });
  const finished = repl.start();

  input.write("/models\n");
  await new Promise((r) => setTimeout(r, 100));

  assert.match(out, /Available Models:/);
  assert.match(out, /google\/gemini-2\.5-flash/);
  assert.match(out, /anthropic\/claude-sonnet-5/);

  input.write("/exit\n");
  await finished;
});

test("system prompt: placeholders are filled, project context is inserted verbatim", () => {
  const p = buildSystemPrompt({
    cwd: "C:\\proj",
    tools: [{ name: "read", description: "Read a file" }],
    projectContext: "rules with $& and $1",
  });
  assert.doesNotMatch(p, /\{\{/);
  assert.match(p, /- read: Read a file/);
  assert.match(p, /READ-ONLY mode/);
  assert.match(p, /rules with \$& and \$1/);
  assert.match(p, /C:\\proj/);
});

test("repl: prompt runs, tool call and answer are rendered, /exit ends the loop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ch-"));
  try {
    let turn = 0;
    const agent = newAgent(
      () =>
        turn++ === 0
          ? assistantMessage([call("c1", "write", { path: "r.txt", content: "hi" })])
          : assistantMessage([{ text: "all done" }]),
      createCodingTools(dir),
    );
    const input = new PassThrough();
    const output = new PassThrough();
    let out = "";
    output.on("data", (d) => (out += d.toString()));

    const repl = new Repl({ agent, getApiKey: () => "k", input, output });
    const finished = repl.start();
    input.write("please write r.txt\n");
    await new Promise((r) => setTimeout(r, 300));
    input.write("/exit\n");
    await finished;

    assert.equal(readFileSync(join(dir, "r.txt"), "utf-8"), "hi");
    assert.match(out, /> write path=r\.txt content=hi/);
    assert.match(out, /Successfully wrote/);
    assert.match(out, /all done/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repl: a line typed while the agent runs steers it", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const seen: Context[] = [];
  let turn = 0;
  const slow: AgentTool<any> = {
    name: "slow",
    label: "slow",
    description: "slow",
    parameters: z.object({}),
    execute: async () => {
      await gate;
      return { content: [{ type: "text", text: "slow done" }] };
    },
  };
  const agent = newAgent(
    (ctx) =>
      turn++ === 0
        ? assistantMessage([call("c1", "slow", {}), call("c2", "slow", {})])
        : assistantMessage([{ text: `reply to: ${lastUserText(ctx)}` }]),
    [slow],
    seen,
  );
  const input = new PassThrough();
  const output = new PassThrough();
  let out = "";
  output.on("data", (d) => (out += d.toString()));

  const repl = new Repl({ agent, getApiKey: () => "k", input, output });
  const finished = repl.start();
  input.write("start\n");
  await new Promise((r) => setTimeout(r, 100));
  input.write("actually do this\n");
  await new Promise((r) => setTimeout(r, 50));
  release();
  await new Promise((r) => setTimeout(r, 200));
  input.write("/exit\n");
  await finished;

  assert.match(out, /reply to: actually do this/);
});

// ---- run -------------------------------------------------------------------

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n     ${error instanceof Error ? (error.stack ?? error.message).split("\n").slice(0, 6).join("\n     ") : error}`);
  }
}
console.log(failed === 0 ? `\nall ${tests.length} passed` : `\n${failed} of ${tests.length} failed`);
process.exit(failed === 0 ? 0 : 1);
