#!/usr/bin/env node
import { getModels, getProviders } from "@coding-harness/ai-providers";
import "dotenv/config";
import {
  Agent,
  buildSystemPrompt,
  createCodingTools,
  loadProjectContext,
} from "@coding-harness/agent";
import { Repl } from "./repl.js";
import { API_KEY_ENV, findModel } from "./model-selector.js";

const HELP = `coding-harness [options] [prompt]

  prompt             first message; the session continues interactively afterwards
  -p, --print        run the prompt, print the answer, exit
  -m, --model <id>   model id, e.g. google/gemini-2.5-flash, openai/gpt-4o, anthropic/claude-3-7-sonnet-latest
  -h, --help         show this help

In the session:
  <text>             send a message; while the agent runs it steers the agent instead
  /models            browse and select a model interactively
  /model <id>        switch to a specific model directly
  /compact [focus]   compact the context now
  /reset             clear the conversation
  /exit              quit
  Ctrl+C             abort the current run; press again to exit

No model is selected at startup: pass --model, or pick one with /models in the session.
--print requires --model.

Required env vars by provider:
  ANTHROPIC_API_KEY   anthropic/*
  GEMINI_API_KEY      google/*
  OPENAI_API_KEY      openai/*`;

interface Args {
  prompt?: string;
  model?: string;
  print: boolean;
  compact: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { print: false, compact: true, help: false };
  const words: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg === "-p" || arg === "--print") args.print = true;
    else if (arg === "--no-compact") args.compact = false;
    else if (arg === "-m" || arg === "--model") {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} needs a model id`);
      args.model = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else words.push(arg);
  }

  if (words.length > 0) args.prompt = words.join(" ");
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (args.print && !args.prompt) {
    throw new Error("--print needs a prompt");
  }
  if (args.print && !args.model) {
    throw new Error("--print needs --model");
  }

  const getApiKey = (provider: string) =>
    process.env[API_KEY_ENV[provider] ?? ""];

  const cwd = process.cwd();
  const tools = createCodingTools(cwd);

  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt({
        cwd,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
        projectContext: loadProjectContext(cwd),
      }),
      tools,
    },
    getApiKey,
  });

  if (args.model) {
    // accepts "<provider>/<id>" (e.g. anthropic/claude-haiku-4-5-20251001) or a bare id
    const model = findModel(args.model);
    if (!model) {
      const known = getProviders()
        .flatMap((p) => getModels(p).map((m) => `${p}/${m.id}`))
        .join(", ");
      throw new Error(`Unknown model "${args.model}". Known: ${known}`);
    }
    if (!getApiKey(model.provider)) {
      throw new Error(
        `${API_KEY_ENV[model.provider] ?? "API key"} is not set (needed for ${model.provider})`,
      );
    }
    agent.setModel(model);
  }

  const repl = new Repl({
    agent,
    getApiKey,
  });

  if (args.print) {
    return (await repl.runPrompt(args.prompt!)) ? 0 : 1;
  }

  if (args.prompt) {
    // run the first message, then hand over to the interactive loop
    await repl.runPrompt(args.prompt);
  }
  await repl.start();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
