import type { Readable, Writable } from "node:stream";

export interface SelectListOptions<T> {
  input: Readable;
  output: Writable;
  title: string;
  items: T[];
  /** one line per item; may contain ANSI codes */
  renderItem: (item: T, selected: boolean) => string;
  /** text the filter query is matched against */
  searchText: (item: T) => string;
  initialIndex?: number;
  /** plural noun for the footer, e.g. "models" */
  noun?: string;
}

export function isInteractive(input: Readable, output: Writable): boolean {
  const stdin = input as NodeJS.ReadStream;
  return Boolean(
    stdin.isTTY &&
      typeof stdin.setRawMode === "function" &&
      (output as NodeJS.WriteStream).isTTY,
  );
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
 * Returns { name, ctrl, str } for the keys the picker needs.
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
 * Interactive filterable list. Resolves the chosen item, or null on Esc / Ctrl+C.
 *
 * Needs a TTY (see isInteractive). The caller must detach readline from the
 * input first (Repl.withRawInput); we take raw mode, listen on 'data', and
 * restore everything before resolving.
 */
export function selectFromList<T>(options: SelectListOptions<T>): Promise<T | null> {
  const { items, renderItem, searchText } = options;
  const noun = options.noun ?? "items";
  const stdin = options.input as NodeJS.ReadStream & { isRaw?: boolean };
  const stdout = options.output as NodeJS.WriteStream;

  return new Promise<T | null>((resolve) => {
    const wasRaw = stdin.isRaw;

    stdin.resume();
    stdin.setRawMode(true);
    stdout.write("\x1b[?25l"); // hide cursor

    let query = "";
    let filtered = items;
    let selectedIndex = Math.min(Math.max(0, options.initialIndex ?? 0), items.length - 1);
    let scrollOffset = 0;
    let lastRenderedLineCount = 0;

    function applyFilter() {
      const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
      filtered =
        terms.length === 0
          ? items
          : items.filter((item) => {
              const text = searchText(item).toLowerCase();
              return terms.every((t) => text.includes(t));
            });
      selectedIndex = 0;
      scrollOffset = 0;
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
        `\x1b[1m\x1b[36m${options.title}\x1b[0m \x1b[2m(type to filter, ↑/↓ navigate, Enter select, Esc cancel)\x1b[0m`,
      );
      lines.push(`\x1b[1mSearch:\x1b[0m ${query}\x1b[7m \x1b[0m`);
      lines.push(`\x1b[2m${divider}\x1b[0m`);

      if (filtered.length === 0) {
        lines.push(`  \x1b[33mNo ${noun} matching "${query}"\x1b[0m`);
      } else {
        visible.forEach((item, offsetIndex) => {
          const isSelected = scrollOffset + offsetIndex === selectedIndex;
          const cursor = isSelected ? "\x1b[36m\x1b[1m> \x1b[0m" : "  ";
          lines.push(`${cursor}${renderItem(item, isSelected)}`);
        });
      }

      lines.push(`\x1b[2m${divider}\x1b[0m`);

      const scrollInfo =
        filtered.length > maxItems
          ? ` (showing ${scrollOffset + 1}-${Math.min(filtered.length, scrollOffset + maxItems)} of ${filtered.length})`
          : "";
      lines.push(
        `\x1b[2mTotal: ${filtered.length} of ${items.length} ${noun}${scrollInfo}\x1b[0m`,
      );

      if (lastRenderedLineCount > 0) {
        stdout.write(`\x1b[${lastRenderedLineCount}A`);
      }
      for (const rawLine of lines) {
        stdout.write(`\r\x1b[2K${truncateAnsi(rawLine, cols)}\n`);
      }
      // the list can shrink while filtering: clear what the previous render left below
      for (let i = lines.length; i < lastRenderedLineCount; i++) {
        stdout.write("\r\x1b[2K\n");
      }
      if (lastRenderedLineCount > lines.length) {
        stdout.write(`\x1b[${lastRenderedLineCount - lines.length}A`);
      }
      lastRenderedLineCount = lines.length;
    }

    function cleanup(result: T | null) {
      stdin.removeListener("data", onData);

      // Erase the menu
      if (lastRenderedLineCount > 0) {
        stdout.write(`\x1b[${lastRenderedLineCount}A`);
        for (let i = 0; i < lastRenderedLineCount; i++) stdout.write("\r\x1b[2K\n");
        stdout.write(`\x1b[${lastRenderedLineCount}A\r\x1b[2K`);
      }
      stdout.write("\x1b[?25h"); // restore cursor

      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();

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
        cleanup(filtered[selectedIndex] ?? null);
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
          applyFilter();
          render();
        }
        return;
      }

      // Printable character → add to filter query
      if (key.str && !key.ctrl) {
        query += key.str;
        applyFilter();
        render();
      }
    }

    stdin.on("data", onData);
    render();
  });
}
