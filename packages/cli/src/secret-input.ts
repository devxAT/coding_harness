import type { Readable, Writable } from "node:stream";

/**
 * Read one line from a raw-mode TTY, echoing "*" per character.
 * Resolves null on Esc / Ctrl+C.
 *
 * Same contract as selectFromList: the caller detaches readline first
 * (Repl.withRawInput), otherwise readline echoes every key as well.
 * The stream is left paused and out of raw mode.
 */
export function readSecretTTY(
  input: Readable,
  output: Writable,
  label: string,
): Promise<string | null> {
  const stdin = input as NodeJS.ReadStream & { isRaw?: boolean };
  const stdout = output as NodeJS.WriteStream;

  return new Promise<string | null>((resolve) => {
    const wasRaw = stdin.isRaw;
    let value = "";

    stdin.resume();
    stdin.setRawMode(true);
    stdout.write(label);

    function finish(result: string | null) {
      stdin.removeListener("data", onData);
      stdout.write("\n");
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      resolve(result);
    }

    function onData(chunk: Buffer | string) {
      // a paste arrives as one chunk, so walk it character by character
      for (const ch of chunk.toString()) {
        const code = ch.charCodeAt(0);
        if (code === 3 || code === 0x1b) return finish(null);
        if (ch === "\r" || ch === "\n") return finish(value);
        if (code === 0x7f || code === 0x08) {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
        } else if (code >= 32) {
          value += ch;
          stdout.write("*");
        }
      }
    }

    stdin.on("data", onData);
  });
}
