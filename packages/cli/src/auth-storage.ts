import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { API_KEY_ENV } from "./model-selector.js";

export type ApiKeyCredential = {
  type: "api_key";
  key: string;
};

export type AuthStorageData = Record<string, ApiKeyCredential>;

/** ~/.coding-harness, or $CODING_HARNESS_DIR */
export function getConfigDir(): string {
  return process.env.CODING_HARNESS_DIR || join(homedir(), ".coding-harness");
}

export function getAuthPath(): string {
  return join(getConfigDir(), "auth.json");
}

/**
 * API keys per provider, stored in a JSON file (mode 0600).
 * Lookup order: auth.json, then the provider's environment variable.
 */
export class AuthStorage {
  private data: AuthStorageData = {};

  constructor(private authPath: string = getAuthPath()) {
    this.reload();
  }

  getPath(): string {
    return this.authPath;
  }

  reload() {
    if (!existsSync(this.authPath)) {
      this.data = {};
      return;
    }
    try {
      this.data = JSON.parse(readFileSync(this.authPath, "utf-8"));
    } catch {
      this.data = {};
    }
  }

  private save() {
    const dir = dirname(this.authPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.authPath, JSON.stringify(this.data, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    chmodSync(this.authPath, 0o600); // mode above only applies when the file is created
  }

  setApiKey(provider: string, key: string) {
    this.data[provider] = { type: "api_key", key };
    this.save();
  }

  remove(provider: string) {
    delete this.data[provider];
    this.save();
  }

  /** providers with a key stored in auth.json */
  list(): string[] {
    return Object.keys(this.data);
  }

  getApiKey(provider: string): string | undefined {
    const stored = this.data[provider];
    if (stored?.type === "api_key" && stored.key) return stored.key;
    const envName = API_KEY_ENV[provider];
    return envName ? process.env[envName] : undefined;
  }
}
