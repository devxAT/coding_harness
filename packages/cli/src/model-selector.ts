import type { Readable, Writable } from "node:stream";
import {
  getModel,
  getModels,
  getProviders,
  ModelInfo,
  ProviderId,
} from "@coding-harness/ai-providers";

export const API_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
};

export interface ModelItem {
  provider: ProviderId;
  id: string;
  name: string;
  model: ModelInfo;
  hasApiKey: boolean;
  isCurrent: boolean;
}

export interface ModelSelectorOptions {
  input: Readable;
  output: Writable;
  getApiKey: (provider: string) => string | undefined;
  currentModel?: ModelInfo;
}

export function findModel(spec: string): ModelInfo | undefined {
  const trimmed = spec.trim();
  for (const provider of getProviders()) {
    if (trimmed.startsWith(`${provider}/`)) {
      const model = getModel(provider, trimmed.slice(provider.length + 1));
      if (model) return model;
    }
  }
  for (const provider of getProviders()) {
    const model = getModel(provider, trimmed);
    if (model) return model;
  }
  return undefined;
}

export function getAllModels(
  getApiKey: (provider: string) => string | undefined,
  currentModel?: ModelInfo,
): ModelItem[] {
  const items: ModelItem[] = [];
  for (const provider of getProviders()) {
    const models = getModels(provider);
    const hasApiKey = Boolean(getApiKey(provider));
    for (const model of models) {
      const isCurrent = Boolean(
        currentModel &&
          currentModel.provider === provider &&
          currentModel.id === model.id,
      );
      items.push({
        provider,
        id: model.id,
        name: model.name || model.id,
        model,
        hasApiKey,
        isCurrent,
      });
    }
  }
  return items;
}

function truncateAnsi(str: string, maxWidth: number): string {
  let visibleLen = 0;
  let result = "";
  let inEscape = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (char === "\x1b") {
      inEscape = true;
      result += char;
    } else if (inEscape) {
      result += char;
      if (char === "m") inEscape = false;
    } else {
      if (visibleLen >= maxWidth) break;
      visibleLen++;
      result += char;
    }
  }

  if (result.includes("\x1b[")) result += "\x1b[0m";
  return result;
}

/**
 * Minimal escape-sequence key parser for raw stdin bytes.
 * Returns { name, ctrl, sequence } for the keys the picker needs.
 */
function parseKey(buf: Buffer): {
  name: string;
  ctrl: boolean;
  str: string | undefined;
} {
  const str = buf.toString("utf8");

  // Ctrl+C = 0x03
  if (buf[0] === 3) return { name: "c", ctrl: true, str: undefined };

  // Escape sequences (arrow keys, etc.)
  if (buf[0] === 0x1b) {
    if (buf.length === 1) return { name: "escape", ctrl: false, str: undefined };
    const seq = str.slice(1);
    if (seq === "[A") return { name: "up", ctrl: false, str: undefined };
    if (seq === "[B") return { name: "down", ctrl: false, str: undefined };
    if (seq === "[H" || seq === "[1~") return { name: "home", ctrl: false, str: undefined };
    if (seq === "[F" || seq === "[4~") return { name: "end", ctrl: false, str: undefined };
    if (seq === "[5~") return { name: "pageup", ctrl: false, str: undefined };
    if (seq === "[6~") return { name: "pagedown", ctrl: false, str: undefined };
    if (seq === "[3~") return { name: "delete", ctrl: false, str: undefined };
    return { name: "unknown", ctrl: false, str: undefined };
  }

  // Enter: CR or LF
  if (buf[0] === 13 || buf[0] === 10) return { name: "return", ctrl: false, str: undefined };

  // Backspace: DEL (0x7f) or BS (0x08)
  if (buf[0] === 0x7f || buf[0] === 0x08) return { name: "backspace", ctrl: false, str: undefined };

  // Ctrl+P / Ctrl+N for navigation (emacs-style)
  if (buf[0] === 16) return { name: "p", ctrl: true, str: undefined };
  if (buf[0] === 14) return { name: "n", ctrl: true, str: undefined };

  // Printable ASCII
  if (buf[0] >= 32 && buf[0] < 127) return { name: str, ctrl: false, str };

  return { name: "unknown", ctrl: false, str: undefined };
}

/**
 * Interactive model picker.
 *
 * Implementation notes:
 * - The caller must call rl.pause() before invoking this, and rl.resume() after.
 * - We own stdin for the duration: setRawMode(true), listen on 'data', then
 *   restore everything before resolving so readline gets its stream back intact.
 * - We never touch readline's internal listeners — we only pause/resume the
 *   readline interface via the caller, which avoids corrupting its state.
 */
export function selectModelInteractive(
  options: ModelSelectorOptions,
): Promise<ModelInfo | null> {
  const allModels = getAllModels(options.getApiKey, options.currentModel);
  const stdin = options.input as NodeJS.ReadStream & { isRaw?: boolean };
  const stdout = options.output as NodeJS.WriteStream;

  const isInteractive = Boolean(
    stdin.isTTY &&
      typeof stdin.setRawMode === "function" &&
      stdout.isTTY,
  );

  // Non-interactive fallback (piped input or headless tests)
  if (!isInteractive) {
    stdout.write("\nAvailable Models:\n");
    for (const item of allModels) {
      const keyTag = item.hasApiKey ? "[key set]" : "[no key]";
      const currentTag = item.isCurrent ? " (current)" : "";
      stdout.write(
        `  ${item.provider}/${item.id} - ${item.name} ${keyTag}${currentTag}\n`,
      );
    }
    stdout.write("\nUse /model <provider/id> to select a model.\n\n");
    return Promise.resolve(null);
  }

  return new Promise<ModelInfo | null>((resolve) => {
    const wasRaw = stdin.isRaw;

    // Take raw ownership: resume stdin (rl.pause() paused it) and go raw
    stdin.resume();
    stdin.setRawMode(true);
    stdout.write("\x1b[?25l"); // hide cursor

    let query = "";
    let selectedIndex = 0;
    let scrollOffset = 0;
    let lastRenderedLineCount = 0;

    function filterModels(): ModelItem[] {
      const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
      if (terms.length === 0) return allModels;
      return allModels.filter((item) => {
        const text = `${item.provider}/${item.id} ${item.name}`.toLowerCase();
        return terms.every((t) => text.includes(t));
      });
    }

    let filtered = filterModels();

    // Pre-select the active model
    if (options.currentModel) {
      const idx = filtered.findIndex((m) => m.isCurrent);
      if (idx !== -1) selectedIndex = idx;
    }

    function render() {
      const cols = Math.max(60, (stdout.columns || 80) - 2);
      const rows = stdout.rows || 24;
      const maxItems = Math.max(3, Math.min(10, rows - 8));

      if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
      else if (selectedIndex >= scrollOffset + maxItems) scrollOffset = selectedIndex - maxItems + 1;
      if (scrollOffset < 0) scrollOffset = 0;

      const visible = filtered.slice(scrollOffset, scrollOffset + maxItems);
      const divider = "─".repeat(Math.min(72, cols));

      const lines: string[] = [];
      lines.push(
        `\x1b[1m\x1b[36mSelect Model\x1b[0m \x1b[2m(type to filter, ↑/↓ navigate, Enter select, Esc cancel)\x1b[0m`,
      );
      lines.push(`\x1b[1mSearch:\x1b[0m ${query}\x1b[7m \x1b[0m`);
      lines.push(`\x1b[2m${divider}\x1b[0m`);

      if (filtered.length === 0) {
        lines.push(`  \x1b[33mNo models matching "${query}"\x1b[0m`);
      } else {
        visible.forEach((item, offsetIndex) => {
          const itemIndex = scrollOffset + offsetIndex;
          const isSelected = itemIndex === selectedIndex;

          const cursor = isSelected ? "\x1b[36m\x1b[1m> \x1b[0m" : "  ";
          const providerTag = `\x1b[34m[${item.provider}]\x1b[0m`;
          const nameStr = isSelected
            ? `\x1b[1m\x1b[36m${item.name}\x1b[0m`
            : item.name;
          const idStr = item.name !== item.id ? ` \x1b[2m(${item.id})\x1b[0m` : "";
          const keyTag = item.hasApiKey
            ? ` \x1b[32m✓\x1b[0m`
            : ` \x1b[33m(no key)\x1b[0m`;
          const currentTag = item.isCurrent ? ` \x1b[35m[current]\x1b[0m` : "";

          lines.push(`${cursor}${providerTag} ${nameStr}${idStr}${keyTag}${currentTag}`);
        });
      }

      lines.push(`\x1b[2m${divider}\x1b[0m`);

      const scrollInfo =
        filtered.length > maxItems
          ? ` (showing ${scrollOffset + 1}-${Math.min(filtered.length, scrollOffset + maxItems)} of ${filtered.length})`
          : "";
      lines.push(
        `\x1b[2mTotal: ${filtered.length} of ${allModels.length} models${scrollInfo}\x1b[0m`,
      );

      if (lastRenderedLineCount > 0) {
        stdout.write(`\x1b[${lastRenderedLineCount}A`);
      }
      for (const rawLine of lines) {
        stdout.write(`\r\x1b[2K${truncateAnsi(rawLine, cols)}\n`);
      }
      lastRenderedLineCount = lines.length;
    }

    function cleanup(result: ModelInfo | null) {
      stdin.removeListener("data", onData);

      // Erase the menu
      if (lastRenderedLineCount > 0) {
        stdout.write(`\x1b[${lastRenderedLineCount}A`);
        for (let i = 0; i < lastRenderedLineCount; i++) stdout.write("\r\x1b[2K\n");
        stdout.write(`\x1b[${lastRenderedLineCount}A\r\x1b[2K`);
      }
      stdout.write("\x1b[?25h"); // restore cursor

      // Hand the stream back to readline (caller will call rl.resume())
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause(); // readline expects the stream to be paused when it resumes

      resolve(result);
    }

    function onData(chunk: Buffer | string) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      const key = parseKey(buf);

      if ((key.ctrl && key.name === "c") || key.name === "escape") {
        cleanup(null);
        return;
      }

      if (key.name === "return") {
        cleanup(filtered[selectedIndex]?.model ?? null);
        return;
      }

      if (key.name === "up" || (key.ctrl && key.name === "p")) {
        if (selectedIndex > 0) { selectedIndex--; render(); }
        return;
      }

      if (key.name === "down" || (key.ctrl && key.name === "n")) {
        if (selectedIndex < filtered.length - 1) { selectedIndex++; render(); }
        return;
      }

      if (key.name === "pageup") {
        selectedIndex = Math.max(0, selectedIndex - 5);
        render();
        return;
      }

      if (key.name === "pagedown") {
        selectedIndex = Math.min(filtered.length - 1, selectedIndex + 5);
        render();
        return;
      }

      if (key.name === "home") { selectedIndex = 0; render(); return; }
      if (key.name === "end") { selectedIndex = Math.max(0, filtered.length - 1); render(); return; }

      if (key.name === "backspace") {
        if (query.length > 0) {
          query = query.slice(0, -1);
          filtered = filterModels();
          selectedIndex = 0;
          scrollOffset = 0;
          render();
        }
        return;
      }

      // Printable character → add to filter query
      if (key.str && !key.ctrl) {
        query += key.str;
        filtered = filterModels();
        selectedIndex = 0;
        scrollOffset = 0;
        render();
      }
    }

    stdin.on("data", onData);
    render();
  });
}
