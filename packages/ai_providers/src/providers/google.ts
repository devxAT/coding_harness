import type {
  Content,
  GenerateContentConfig,
  GenerateContentParameters,
  Part,
  Schema,
  ThinkingConfig,
} from "@google/genai";
import { FinishReason, FunctionCallingConfigMode, GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { calculateCost } from "../provider.js";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  ModelInfo,
  StopReason,
  StreamFunction,
  StreamOptions,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicodes.js";
import { transformMessages } from "../utils/tranform-messages.js";

export interface GoogleOptions extends StreamOptions {
  toolChoice?: "auto" | "none" | "any";
  thinking?: {
    enabled: boolean;
    /** Token budget for thinking. -1 = dynamic, 0 = disable. */
    budgetTokens?: number;
  };
}

// Module-level counter for generating unique tool call IDs when Gemini omits them.
let toolCallCounter = 0;

export const googleStream: StreamFunction = (
  model: ModelInfo,
  context: Context,
  options?: GoogleOptions,
): AssistantMessageEventStream => {
  const stream = new AssistantMessageEventStream();

  void fetchStream(stream, model, context, options);

  return stream;
};

async function fetchStream(
  stream: AssistantMessageEventStream,
  model: ModelInfo,
  context: Context,
  options?: GoogleOptions,
) {
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timeStamp: Date.now(),
    errorMessage: "",
  };

  try {
    const client = createClient(model, options?.apiKey);
    const params = buildParams(model, context, options);

    if (options?.signal?.aborted) {
      throw new Error("Request aborted");
    }

    const geminiStream = await client.models.generateContentStream(params);

    stream.push({ type: "start", partial: output });

    const blocks = output.content;
    const blockIndex = () => blocks.length - 1;

    // Track the text/thinking block currently receiving deltas.
    let currentBlock: TextContent | ThinkingContent | null = null;

    const finishCurrentBlock = () => {
      if (!currentBlock) return;
      if (currentBlock.type === "text") {
        stream.push({ type: "text_end", contentIndex: blockIndex(), content: currentBlock.text, partial: output });
      } else {
        stream.push({
          type: "thinking_end",
          contentIndex: blockIndex(),
          content: currentBlock.thinking,
          partial: output,
        });
      }
      currentBlock = null;
    };

    for await (const chunk of geminiStream) {
      const candidate = chunk.candidates?.[0];

      if (candidate?.content?.parts) {
        for (const part of candidate.content.parts) {
          // ── Text / Thinking delta ──
          if (part.text !== undefined) {
            const isThinking = part.thought === true;

            // Open a new block when the type changes.
            if (
              !currentBlock ||
              (isThinking && currentBlock.type !== "thinking") ||
              (!isThinking && currentBlock.type !== "text")
            ) {
              finishCurrentBlock();
              if (isThinking) {
                currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
                output.content.push(currentBlock);
                stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
              } else {
                currentBlock = { type: "text", text: "" };
                output.content.push(currentBlock);
                stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
              }
            }

            if (currentBlock.type === "thinking") {
              currentBlock.thinking += part.text;
              // Gemini 2.5+ sends thoughtSignature per chunk; keep the last one.
              if (part.thoughtSignature) {
                currentBlock.thinkingSignature = part.thoughtSignature;
              }
              stream.push({
                type: "thinking_delta",
                contentIndex: blockIndex(),
                delta: part.text,
                partial: output,
              });
            } else {
              (currentBlock as TextContent).text += part.text;
              stream.push({
                type: "text_delta",
                contentIndex: blockIndex(),
                delta: part.text,
                partial: output,
              });
            }
          }

          // ── Tool call (Gemini delivers the full functionCall in one part, not streamed) ──
          if (part.functionCall) {
            finishCurrentBlock();

            // Generate a stable ID when Gemini omits one or produces a duplicate.
            const providedId = part.functionCall.id;
            const isDuplicate =
              providedId !== undefined &&
              output.content.some((b) => b.type === "toolCall" && b.id === providedId);
            const toolCallId =
              !providedId || isDuplicate
                ? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
                : providedId;

            const toolCall: ToolCall = {
              type: "toolCall",
              id: toolCallId,
              name: part.functionCall.name ?? "",
              arguments: (part.functionCall.args ?? {}) as Record<string, unknown>,
              ...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
            };

            output.content.push(toolCall);
            stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
            stream.push({
              type: "toolcall_delta",
              contentIndex: blockIndex(),
              delta: JSON.stringify(toolCall.arguments),
              partial: output,
            });
            stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
          }
        }
      }

      // ── Finish reason ──
      if (candidate?.finishReason) {
        output.stopReason = mapStopReason(candidate.finishReason);
        // Override to "toolUse" when the response contains tool calls.
        if (output.content.some((b) => b.type === "toolCall")) {
          output.stopReason = "toolUse";
        }
      }

      // ── Usage ──
      if (chunk.usageMetadata) {
        const meta = chunk.usageMetadata;
        output.usage.input = meta.promptTokenCount ?? 0;
        output.usage.cacheRead = meta.cachedContentTokenCount ?? 0;
        output.usage.cacheWrite = 0;
        // candidatesTokenCount + thoughtsTokenCount = total output tokens
        output.usage.output = (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0);
        if (meta.thoughtsTokenCount) {
          output.usage.reasoning = meta.thoughtsTokenCount;
        }
        output.usage.totalTokens = meta.totalTokenCount ?? 0;
        calculateCost(model, output.usage);
      }
    }

    // Close any still-open text/thinking block.
    finishCurrentBlock();

    if (options?.signal?.aborted) {
      throw new Error("Request was aborted");
    }

    if (output.stopReason === "aborted" || output.stopReason === "error") {
      throw new Error(output.errorMessage || "An unknown error occurred");
    }

    stream.push({ type: "done", reason: output.stopReason, message: output });
    stream.end();
  } catch (error) {
    output.stopReason = options?.signal?.aborted ? "aborted" : "error";
    output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
    stream.push({ type: "error", reason: output.stopReason, error: output });
    stream.end();
  }
}

function createClient(model: ModelInfo, apiKey?: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    ...(model.headers && { httpOptions: { headers: model.headers } }),
  });
}

function buildParams(
  model: ModelInfo,
  context: Context,
  options: GoogleOptions = {},
): GenerateContentParameters {
  const contents = convertMessages(model, context);

  const generationConfig: GenerateContentConfig = {};
  if (options.temperature !== undefined) {
    generationConfig.temperature = options.temperature;
  }
  if (options.maxTokens !== undefined) {
    generationConfig.maxOutputTokens = options.maxTokens;
  }

  const config: GenerateContentConfig = {
    ...(Object.keys(generationConfig).length > 0 && generationConfig),
    ...(context.systemPrompt && { systemInstruction: sanitizeSurrogates(context.systemPrompt) }),
    ...(context.tools && context.tools.length > 0 && { tools: convertTools(context.tools) }),
  };

  // Tool choice config (only meaningful when tools are present).
  if (context.tools && context.tools.length > 0 && options.toolChoice) {
    config.toolConfig = {
      functionCallingConfig: { mode: mapToolChoice(options.toolChoice) },
    };
  }

  // Thinking config (Gemini 2.5+ only).
  if (options.thinking?.enabled && model.reasoning) {
    const thinkingConfig: ThinkingConfig = { includeThoughts: true };
    if (options.thinking.budgetTokens !== undefined) {
      thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
    }
    config.thinkingConfig = thinkingConfig;
  }

  if (options.signal) {
    config.abortSignal = options.signal;
  }

  return { model: model.id, contents, config };
}

// ─────────────────────────────────────────────────────────────────────────────
// Message / tool conversion
// ─────────────────────────────────────────────────────────────────────────────

function convertMessages(model: ModelInfo, context: Context): Content[] {
  const contents: Content[] = [];
  const transformed = transformMessages(context.messages, model);

  for (const msg of transformed) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        const text = sanitizeSurrogates(msg.content);
        if (text.trim().length === 0) continue;
        contents.push({ role: "user", parts: [{ text }] });
      } else {
        const parts: Part[] = msg.content.flatMap((item): Part[] => {
          if (item.type === "text") {
            const text = sanitizeSurrogates(item.text);
            return text.trim().length > 0 ? [{ text }] : [];
          } else if (model.input.includes("image")) {
            const img = item as ImageContent;
            return [{ inlineData: { mimeType: img.mimeType, data: img.image } }];
          }
          return [];
        });
        if (parts.length === 0) continue;
        contents.push({ role: "user", parts });
      }
    } else if (msg.role === "assistant") {
      const parts: Part[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          if (!block.text || block.text.trim() === "") continue;
          parts.push({ text: sanitizeSurrogates(block.text) });
        } else if (block.type === "thinking") {
          if (block.thinkingSignature) {
            parts.push({
              thought: true,
              text: sanitizeSurrogates(block.thinking),
              thoughtSignature: block.thinkingSignature,
            });
          } else if (block.thinking.trim().length > 0) {
            // No signature: wrap in delimiters and send as plain text.
            parts.push({ text: `<thinking>\n${sanitizeSurrogates(block.thinking)}\n</thinking>` });
          }
        } else if (block.type === "toolCall") {
          const part: Part = {
            functionCall: {
              id: block.id,
              name: block.name,
              args: block.arguments,
            },
          };
          if (block.thoughtSignature) {
            part.thoughtSignature = block.thoughtSignature;
          }
          parts.push(part);
        }
      }

      if (parts.length === 0) continue;
      contents.push({ role: "model", parts });
    } else if (msg.role === "toolResult") {
      const result = msg as ToolResultMessage;
      const textParts = result.content.filter((c): c is TextContent => c.type === "text");
      const textResult = textParts.map((c) => c.text).join("\n");
      const imageParts = model.input.includes("image")
        ? result.content.filter((c): c is ImageContent => c.type === "image")
        : [];

      const responseValue =
        textResult.length > 0
          ? sanitizeSurrogates(textResult)
          : imageParts.length > 0
            ? "(see attached image)"
            : "";

      const functionResponsePart: Part = {
        functionResponse: {
          id: result.toolCallId,
          name: result.toolName,
          response: result.isError ? { error: responseValue } : { output: responseValue },
        },
      };

      // Gemini requires all function responses in a single user turn.
      const lastContent = contents[contents.length - 1];
      if (lastContent?.role === "user" && lastContent.parts?.some((p) => p.functionResponse)) {
        lastContent.parts.push(functionResponsePart);
      } else {
        contents.push({ role: "user", parts: [functionResponsePart] });
      }

      // Images go in a separate follow-up user turn.
      if (imageParts.length > 0) {
        const inlineParts: Part[] = imageParts.map((img) => ({
          inlineData: { mimeType: img.mimeType, data: img.image },
        }));
        contents.push({ role: "user", parts: [{ text: "Tool result image:" }, ...inlineParts] });
      }
    }
  }

  return contents;
}

function convertTools(
  tools: Tool[],
): { functionDeclarations: { name: string; description?: string; parameters: Schema }[] }[] {
  return [
    {
      functionDeclarations: tools.map((tool) => {
        const schema = z.toJSONSchema(tool.parameters, { target: "draft-7" }) as Record<string, unknown>;
        delete schema["$schema"]; // Gemini rejects the $schema field
        return {
          name: tool.name,
          description: tool.description,
          parameters: schema as Schema,
        };
      }),
    },
  ];
}

function mapToolChoice(choice: string): FunctionCallingConfigMode {
  switch (choice) {
    case "none":
      return FunctionCallingConfigMode.NONE;
    case "any":
      return FunctionCallingConfigMode.ANY;
    default:
      return FunctionCallingConfigMode.AUTO;
  }
}

function mapStopReason(reason: FinishReason): StopReason {
  switch (reason) {
    case FinishReason.STOP:
      return "stop";
    case FinishReason.MAX_TOKENS:
      return "length";
    case FinishReason.BLOCKLIST:
    case FinishReason.PROHIBITED_CONTENT:
    case FinishReason.SPII:
    case FinishReason.SAFETY:
    case FinishReason.IMAGE_SAFETY:
    case FinishReason.IMAGE_PROHIBITED_CONTENT:
    case FinishReason.IMAGE_RECITATION:
    case FinishReason.IMAGE_OTHER:
    case FinishReason.RECITATION:
    case FinishReason.FINISH_REASON_UNSPECIFIED:
    case FinishReason.OTHER:
    case FinishReason.LANGUAGE:
    case FinishReason.MALFORMED_FUNCTION_CALL:
    case FinishReason.UNEXPECTED_TOOL_CALL:
    case FinishReason.NO_IMAGE:
      return "error";
    default: {
      const _exhaustive: never = reason;
      throw new Error(`Unhandled Gemini finish reason: ${_exhaustive}`);
    }
  }
}
