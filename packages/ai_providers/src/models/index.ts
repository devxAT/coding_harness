import { ModelInfo } from "../types.js";
import { ANTHROPIC_MODELS } from "./anthropic.js";
import { MISTRAL_MODELS } from "./mistral.js";
import { OPENAI_MODELS, OPENROUTER_MODELS } from "./openai.js";
import { XAI_MODELS } from "./xai.js";

export const MODELS = {
  anthropic: ANTHROPIC_MODELS,
  openai: OPENAI_MODELS,
  openrouter: OPENROUTER_MODELS,
  xai: XAI_MODELS,
  mistral: MISTRAL_MODELS,
};

export const modelRegistry: Map<string, Map<string, ModelInfo>> = new Map();

for (const [provider, models] of Object.entries(MODELS)) {
  const providerModels = new Map<string, ModelInfo>();
  for (const model of models) {
    providerModels.set(model.id, model);
  }
  modelRegistry.set(provider, providerModels);
}
