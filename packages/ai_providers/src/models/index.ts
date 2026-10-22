import { ModelInfo } from "../types.js";
import { ANTHROPIC_MODELS } from "./anthropic.js";
import { GOOGLE_MODELS } from "./google.js";
import { OPENAI_MODELS } from "./openai.js";

export { MISTRAL_MODELS } from "./mistral.js";
export { OPENROUTER_MODELS } from "./openRouter.js";
export { XAI_MODELS } from "./xai.js";

export const MODELS = {
  anthropic: ANTHROPIC_MODELS,
  google: GOOGLE_MODELS,
  openai: OPENAI_MODELS,
};

export const modelRegistry: Map<string, Map<string, ModelInfo>> = new Map();

for (const [provider, models] of Object.entries(MODELS)) {
  const providerModels = new Map<string, ModelInfo>();
  for (const model of models) {
    providerModels.set(model.id, model);
  }
  modelRegistry.set(provider, providerModels);
}
