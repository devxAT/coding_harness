import type { Readable, Writable } from "node:stream";
import {
  getModel,
  getModels,
  getProviders,
  ModelInfo,
  ProviderId,
} from "@coding-harness/ai-providers";
import { isInteractive, selectFromList } from "./select-list.js";

export const API_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
};

/** providers that /login can store an API key for */
export const LOGIN_PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: "anthropic", label: "Anthropic" },
  { id: "google", label: "Google Gemini" },
  { id: "openai", label: "OpenAI" },
];

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

/** models whose provider has an API key; only these can be selected */
export function getAvailableModels(
  getApiKey: (provider: string) => string | undefined,
  currentModel?: ModelInfo,
): ModelItem[] {
  return getAllModels(getApiKey, currentModel).filter((m) => m.hasApiKey);
}

function renderModel(item: ModelItem, selected: boolean): string {
  const providerTag = `\x1b[34m[${item.provider}]\x1b[0m`;
  const nameStr = selected ? `\x1b[1m\x1b[36m${item.name}\x1b[0m` : item.name;
  const idStr = item.name !== item.id ? ` \x1b[2m(${item.id})\x1b[0m` : "";
  const currentTag = item.isCurrent ? ` \x1b[35m[current]\x1b[0m` : "";
  return `${providerTag} ${nameStr}${idStr}${currentTag}`;
}

/**
 * Interactive model picker over the models that have an API key.
 * Resolves null when cancelled, when nothing is available, or when not on a TTY
 * (then it prints the list instead).
 */
export function selectModelInteractive(
  options: ModelSelectorOptions,
): Promise<ModelInfo | null> {
  const models = getAvailableModels(options.getApiKey, options.currentModel);
  const stdout = options.output;

  if (models.length === 0) {
    stdout.write("\nNo models available: no API key is set. Run /login to add one.\n\n");
    return Promise.resolve(null);
  }

  // Non-interactive fallback (piped input or headless tests)
  if (!isInteractive(options.input, options.output)) {
    stdout.write("\nAvailable Models:\n");
    for (const item of models) {
      const currentTag = item.isCurrent ? " (current)" : "";
      stdout.write(`  ${item.provider}/${item.id} - ${item.name}${currentTag}\n`);
    }
    stdout.write("\nUse /model <provider/id> to select a model.\n\n");
    return Promise.resolve(null);
  }

  return selectFromList({
    input: options.input,
    output: options.output,
    title: "Select Model",
    items: models,
    renderItem: renderModel,
    searchText: (item) => `${item.provider}/${item.id} ${item.name}`,
    initialIndex: Math.max(0, models.findIndex((m) => m.isCurrent)),
    noun: "models",
  }).then((item) => item?.model ?? null);
}
