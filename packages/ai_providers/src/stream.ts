import { AnthropicOptions, anthropicStream } from "./providers/anthropic.js";
import { GoogleOptions, googleStream } from "./providers/google.js";
import { OpenAIOptions, openaiStream } from "./providers/openai.js";
import { Context, ModelInfo } from "./types.js";

export function stream(
  model: ModelInfo,
  context: Context,
  options?: AnthropicOptions | GoogleOptions | OpenAIOptions,
) {
  if (model.provider === "anthropic") {
    return anthropicStream(model, context, options as AnthropicOptions);
  }
  if (model.provider === "google") {
    return googleStream(model, context, options as GoogleOptions);
  }
  // openai, openrouter, xai, mistral, and any other OpenAI-compatible provider
  return openaiStream(model, context, options as OpenAIOptions);
}

export function complete(
  model: ModelInfo,
  context: Context,
  options?: AnthropicOptions | GoogleOptions | OpenAIOptions,
) {
  const s = stream(model, context, options);
  return s.result();
}
