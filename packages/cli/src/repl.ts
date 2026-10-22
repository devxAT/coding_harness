import { createInterface, Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  Agent,
  AgentEvent,
} from "@coding-harness/agent";
import {
  API_KEY_ENV,
  findModel,
  LOGIN_PROVIDERS,
  selectModelInteractive,
} from "./model-selector.js";
import { AuthStorage } from "./auth-storage.js";
import { isInteractive, readSecretTTY } from "./secret-input.js";

type LoginProvider = (typeof LOGIN_PROVIDERS)[number];

export interface ReplOptions {
  agent: Agent;
  getApiKey: (provider: string) => string | undefined;
  /** where /login stores keys; /login and /logout are unavailable without it */
  auth?: AuthStorage;
  input?: Readable;
  output?: Writable;
}

const MAX_ARG_CHARS = 80;
const MAX_RESULT_LINES = 3;
const MAX_RESULT_LINE_CHARS = 160;

function short(text: string, max: number): string {
  const flat = text.replace(/\r?\n/g, "\\n");
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function formatArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  return Object.entries(args)
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return `${key}=${short(text ?? "", MAX_ARG_CHARS)}`;
    })
    .join(" ");
}

function resultText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] })
    ?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

/**
 * Line-based terminal frontend for an Agent.
 *
 * - a line typed while idle is a prompt (or a /command)
 * - a line typed while the agent runs steers it: remaining tool calls are skipped
 *   and the line is delivered as the next user message
 * - Ctrl+C aborts the current run; Ctrl+C again exits
 */
export class Repl {
  private agent: Agent;
  private getApiKey: (provider: string) => string | undefined;
  private auth?: AuthStorage;
  private input: Readable;
  private output: Writable;
  private color: boolean;

  private rl?: Interface;
  private current?: Promise<void>;
  private running = false;
  private abortRequested = false;
  private forcedExit = false;
  private closed = false;
  private atLineStart = true;
  /** per tool call: bash output already printed, so partial updates only add the new tail */
  private streamedOutput = new Map<string, string>();
  /** lines typed while running but not streaming */
  private queued: string[] = [];

  constructor(options: ReplOptions) {
    this.agent = options.agent;
    this.getApiKey = options.getApiKey;
    this.auth = options.auth;
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.color = Boolean((this.output as { isTTY?: boolean }).isTTY);

    this.agent.subscribe((event) => this.render(event));
  }

  //helpers

  private write(text: string) {
    if (text.length === 0) return;
    this.output.write(text);
    this.atLineStart = text.endsWith("\n");
  }

  private writeLine(text: string) {
    this.ensureNewline();
    this.write(`${text}\n`);
  }

  private ensureNewline() {
    if (!this.atLineStart) this.write("\n");
  }

  private dim(text: string): string {
    return this.color ? `\x1b[2m${text}\x1b[22m` : text;
  }

  private red(text: string): string {
    return this.color ? `\x1b[31m${text}\x1b[39m` : text;
  }

  // agent events

  private render(event: AgentEvent) {
    switch (event.type) {
      case "message_update": {
        const e = event.assistantMessageEvent;
        if (e.type === "text_delta") this.write(e.delta);
        else if (e.type === "thinking_delta") this.write(this.dim(e.delta));
        else if (e.type === "thinking_end") this.ensureNewline();
        break;
      }

      case "message_end":
        if (event.message.role === "assistant") this.ensureNewline();
        break;

      case "tool_execution_start":
        this.writeLine(
          this.dim(`> ${event.toolName} ${formatArgs(event.args)}`),
        );
        break;

      case "tool_execution_update": {
        if (event.toolName !== "bash") break;
        // partialResult holds the whole rolling output; print only what is new
        const text = resultText(event.partialResult);
        const printed = this.streamedOutput.get(event.toolCallId) ?? "";
        if (text.length > printed.length && text.startsWith(printed)) {
          this.write(text.slice(printed.length));
          this.streamedOutput.set(event.toolCallId, text);
        }
        break;
      }

      case "tool_execution_end": {
        const alreadyStreamed = this.streamedOutput.has(event.toolCallId);
        this.streamedOutput.delete(event.toolCallId);
        this.ensureNewline();
        if (alreadyStreamed) {
          if (event.isError) this.writeLine(this.red("  [tool failed]"));
          break;
        }
        const lines = resultText(event.result).split("\n").filter(Boolean);
        const shown = lines
          .slice(0, MAX_RESULT_LINES)
          .map((l) => `  ${short(l, MAX_RESULT_LINE_CHARS)}`);
        if (lines.length > MAX_RESULT_LINES) {
          shown.push(`  ... (+${lines.length - MAX_RESULT_LINES} more lines)`);
        }
        const body = shown.join("\n");
        if (body) this.writeLine(event.isError ? this.red(body) : this.dim(body));
        break;
      }
    }
  }

  // running prompt

  private noModelNotice() {
    this.writeLine(
      this.dim("No model selected. Type /models to pick one, or /model <provider/id>"),
    );
  }

  /** Returns true when a key is missing (and says so) */
  private warnIfNoKey(provider: string): boolean {
    if (this.getApiKey(provider)) return false;
    const envName = API_KEY_ENV[provider] ?? "API key";
    this.writeLine(
      this.red(`No API key for ${provider}. Run /login, or set ${envName}`),
    );
    return true;
  }

  /** Run one prompt to completion. Returns false if it ended in error or abort. */
  async runPrompt(text: string): Promise<boolean> {
    const model = this.agent.state.model;
    if (!model) {
      this.noModelNotice();
      return false;
    }
    if (this.warnIfNoKey(model.provider)) return false;
    this.running = true;
    try {
      await this.agent.prompt(text);
      return this.reportOutcome();
    } finally {
      this.running = false;
      this.abortRequested = false;
    }
  }

  private reportOutcome(): boolean {
    const messages = this.agent.state.messages;
    const last = messages[messages.length - 1];
    if (last?.role !== "assistant") return true;
    if (last.stopReason === "error") {
      this.writeLine(this.red(`Error: ${last.errorMessage || "unknown error"}`));
      return false;
    }
    if (last.stopReason === "aborted") {
      this.writeLine(this.dim("[aborted]"));
      return false;
    }
    return true;
  }

  private async handleModelCommand(line: string): Promise<void> {
    const parts = line.trim().split(/\s+/);
    const arg = parts.slice(1).join(" ").trim();

    if (arg) {
      const model = findModel(arg);
      if (!model) {
        this.writeLine(
          this.red(`Unknown model "${arg}". Type /models to browse available models.`),
        );
        return;
      }
      this.agent.setModel(model);
      this.writeLine(
        this.dim(`[model switched to ${model.provider}/${model.id}]`),
      );
      this.warnIfNoKey(model.provider);
      return;
    }

    this.rl?.pause();
    try {
      const selected = await selectModelInteractive({
        input: this.input,
        output: this.output,
        getApiKey: this.getApiKey,
        currentModel: this.agent.state.model,
      });

      if (selected) {
        this.agent.setModel(selected);
        this.writeLine(
          this.dim(`[model switched to ${selected.provider}/${selected.id}]`),
        );
        this.warnIfNoKey(selected.provider);
      } else {
        this.writeLine(this.dim("[model selection cancelled]"));
      }
    } finally {
      // Restore readline: resume its stream ownership, then redraw the prompt
      this.rl?.resume();
      if (!this.closed && !this.running) this.rl?.prompt();
    }
  }

  /** Ask a question through readline; the answer line does not reach the "line" handler */
  private ask(query: string): Promise<string> {
    return new Promise((resolve) => {
      if (!this.rl || this.closed) return resolve("");
      this.rl.question(query, resolve);
    });
  }

  /** Resolve a provider from an argument, or ask for it by number */
  private async pickProvider(
    arg: string,
    choices: LoginProvider[],
  ): Promise<LoginProvider | undefined> {
    const match = (s: string) => {
      const v = s.trim().toLowerCase();
      return choices.find(
        (p, i) => p.id === v || p.label.toLowerCase() === v || String(i + 1) === v,
      );
    };
    if (arg) {
      const found = match(arg);
      if (!found) this.writeLine(this.red(`Unknown provider "${arg}"`));
      return found;
    }
    this.writeLine("Select a provider:");
    choices.forEach((p, i) => this.writeLine(`  ${i + 1}. ${p.label}`));
    return match(await this.ask(`Provider [1-${choices.length}]: `));
  }

  private async handleLoginCommand(arg: string): Promise<void> {
    if (!this.auth) {
      this.writeLine(this.red("/login is not available"));
      return;
    }
    const provider = await this.pickProvider(arg, LOGIN_PROVIDERS);
    if (!provider) {
      this.writeLine(this.dim("[login cancelled]"));
      return;
    }

    const label = `${provider.label} API key: `;
    let key: string | null;
    if (isInteractive(this.input, this.output)) {
      this.rl?.pause();
      try {
        key = await readSecretTTY(this.input, this.output, label);
      } finally {
        this.rl?.resume();
      }
    } else {
      key = await this.ask(label);
    }

    key = key?.trim() ?? "";
    if (!key) {
      this.writeLine(this.dim("[login cancelled]"));
      return;
    }
    this.auth.setApiKey(provider.id, key);
    this.writeLine(
      this.dim(`[${provider.label} API key saved to ${this.auth.getPath()}]`),
    );
  }

  private async handleLogoutCommand(arg: string): Promise<void> {
    if (!this.auth) {
      this.writeLine(this.red("/logout is not available"));
      return;
    }
    const stored = this.auth.list();
    const choices = LOGIN_PROVIDERS.filter((p) => stored.includes(p.id));
    if (choices.length === 0) {
      this.writeLine(this.dim("[no saved API keys]"));
      return;
    }
    const provider = await this.pickProvider(arg, choices);
    if (!provider) {
      this.writeLine(this.dim("[logout cancelled]"));
      return;
    }
    this.auth.remove(provider.id);
    this.writeLine(this.dim(`[${provider.label} API key removed]`));
  }

  private async handleLine(line: string): Promise<void> {
    if (line === "/exit" || line === "/quit") {
      this.rl?.close();
      return;
    }
    if (line === "/reset") {
      this.agent.reset();
      this.writeLine(this.dim("[conversation cleared]"));
      return;
    }
    if (
      line === "/models" ||
      line === "/model" ||
      line.startsWith("/models ") ||
      line.startsWith("/model ")
    ) {
      await this.handleModelCommand(line);
      return;
    }
    const [command, ...rest] = line.split(/\s+/);
    if (command === "/login") {
      await this.handleLoginCommand(rest.join(" "));
      return;
    }
    if (command === "/logout") {
      await this.handleLogoutCommand(rest.join(" "));
      return;
    }
    await this.runPrompt(line);
  }

  /** Handle a line, then any lines that were typed meanwhile */
  private async drain(first: string): Promise<void> {
    let next: string | undefined = first;
    while (next !== undefined) {
      this.running = true;
      try {
        await this.handleLine(next);
      } catch (error) {
        this.writeLine(
          this.red(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      } finally {
        this.running = false;
        this.abortRequested = false;
      }
      next = this.queued.shift();
    }
    if (!this.closed) this.rl?.prompt();
  }

  private interrupt() {
    if (this.running && !this.abortRequested) {
      this.abortRequested = true;
      this.agent.abort();
      this.writeLine(this.dim("[aborting, press Ctrl+C again to exit]"));
      return;
    }
    this.forcedExit = true;
    this.agent.abort();
    this.rl?.close();
  }

  /** Read lines until /exit, Ctrl+C Ctrl+C, or end of input */
  start(): Promise<void> {
    const model = this.agent.state.model;
    if (!model) this.noModelNotice();
    else this.warnIfNoKey(model.provider);

    const rl = createInterface({
      input: this.input,
      output: this.output,
      prompt: "> ",
    });
    this.rl = rl;

    return new Promise<void>((resolve) => {
      rl.on("line", (raw) => {
        const line = raw.trim();
        if (!line) {
          if (!this.running) rl.prompt();
          return;
        }
        if (this.running) {
          if (this.agent.state.isStreaming) {
            this.agent.steer({
              role: "user",
              content: [{ type: "text", text: line }],
              timestamp: Date.now(),
            });
          } else {
            this.queued.push(line);
          }
          return;
        }
        this.current = this.drain(line);
      });

      rl.on("SIGINT", () => this.interrupt());

      rl.on("close", () => {
        this.closed = true;
        if (this.forcedExit) return resolve();
        // input ended (or /exit): let the current run finish first
        void (this.current ?? Promise.resolve()).then(() => resolve());
      });

      rl.prompt();
    });
  }
}
