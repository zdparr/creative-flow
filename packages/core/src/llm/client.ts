import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

export type ModelTier = 'fast' | 'strong';

export interface TokenUsage {
  /** Uncached input tokens, including tokens written to the cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmRequest {
  tier: ModelTier;
  system: string;
  messages: Anthropic.MessageParam[];
  maxTokens: number;
  /** When set (and structured outputs are enabled), constrains the response to this schema. */
  outputSchema?: z.ZodType;
}

export interface LlmResponse {
  text: string;
  model: string;
  stopReason: string | null;
  usage: TokenUsage;
}

/** A client-side tool the model may call during a streamed response. */
export interface LlmTool<I = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  /** Returns the tool result text shown to the model. Input is already validated. */
  run: (input: I) => Promise<string>;
}

export interface StreamRequest extends Omit<LlmRequest, 'outputSchema'> {
  onText: (delta: string) => void;
  tools?: LlmTool[];
  /** Upper bound on tool-call rounds within one response. */
  maxToolRounds?: number;
}

/** The seam every agent calls through; tests substitute a fake that replays fixtures. */
export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
  /** Streams prose, running any tool calls in between; `text` is all prose across rounds. */
  stream(request: StreamRequest): Promise<LlmResponse>;
}

export class LlmRefusalError extends Error {
  constructor(readonly category: string | null) {
    super(`The model declined the request${category ? ` (${category})` : ''}`);
    this.name = 'LlmRefusalError';
  }
}

/**
 * Classifies an Anthropic SDK error for callers that should not depend on the SDK.
 * Returns null for anything else. `transient` errors (rate limits, overload, 5xx) are worth retrying.
 */
export function describeLlmError(err: unknown): { transient: boolean; message: string } | null {
  if (!(err instanceof Anthropic.APIError)) return null;
  const transient =
    err instanceof Anthropic.RateLimitError ||
    err instanceof Anthropic.APIConnectionError ||
    (err.status ?? 0) >= 500;
  return { transient, message: err.message };
}

export interface AnthropicLlmOptions {
  models: Record<ModelTier, string>;
  /** Off by default until every configured model supports output_config.format. */
  structuredOutputs: boolean;
  apiKey?: string;
}

// Fast-tier calls sit in the play loop's latency budget; strong-tier calls are background jobs.
const EFFORT: Record<ModelTier, 'medium' | 'high'> = { fast: 'medium', strong: 'high' };

function usageOf(message: Anthropic.Message): TokenUsage {
  const cacheWrite = message.usage.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: message.usage.input_tokens + cacheWrite,
    outputTokens: message.usage.output_tokens,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: cacheWrite,
  };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

const textOf = (message: Anthropic.Message) =>
  message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicLlmOptions) {
    this.client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
  }

  private base(request: LlmRequest | StreamRequest) {
    return {
      model: this.options.models[request.tier],
      max_tokens: request.maxTokens,
      // The system prompt is the stable prefix, so it is the cache breakpoint.
      system: [
        {
          type: 'text' as const,
          text: request.system,
          cache_control: { type: 'ephemeral' as const },
        },
      ],
      thinking: { type: 'adaptive' as const },
    };
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    // Streaming avoids HTTP timeouts on long outputs; finalMessage() assembles the result.
    const stream = this.client.messages.stream({
      ...this.base(request),
      messages: request.messages,
      output_config: {
        effort: EFFORT[request.tier],
        ...(request.outputSchema && this.options.structuredOutputs
          ? { format: zodOutputFormat(request.outputSchema) }
          : {}),
      },
    });
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') {
      throw new LlmRefusalError(message.stop_details?.category ?? null);
    }
    return {
      text: textOf(message),
      model: message.model,
      stopReason: message.stop_reason,
      usage: usageOf(message),
    };
  }

  async stream(request: StreamRequest): Promise<LlmResponse> {
    const tools = request.tools ?? [];
    const apiTools: Anthropic.Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: z.toJSONSchema(t.inputSchema) as Anthropic.Tool.InputSchema,
    }));
    const messages = [...request.messages];
    let usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    let text = '';

    for (let round = 0; ; round++) {
      const stream = this.client.messages.stream({
        ...this.base(request),
        messages,
        output_config: { effort: EFFORT[request.tier] },
        ...(apiTools.length && round < (request.maxToolRounds ?? 4) ? { tools: apiTools } : {}),
      });
      stream.on('text', (delta) => request.onText(delta));
      const message = await stream.finalMessage();
      usage = addUsage(usage, usageOf(message));
      text += textOf(message);

      if (message.stop_reason === 'refusal') {
        throw new LlmRefusalError(message.stop_details?.category ?? null);
      }
      const calls = message.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
      if (message.stop_reason !== 'tool_use' || calls.length === 0) {
        return { text, model: message.model, stopReason: message.stop_reason, usage };
      }

      messages.push({ role: 'assistant', content: message.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        const tool = tools.find((t) => t.name === call.name);
        const parsed = tool?.inputSchema.safeParse(call.input);
        if (!tool || !parsed?.success) {
          results.push({
            type: 'tool_result',
            tool_use_id: call.id,
            is_error: true,
            content: tool
              ? `Invalid input: ${parsed?.error?.message}`
              : `Unknown tool ${call.name}`,
          });
          continue;
        }
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: await tool.run(parsed.data),
        });
      }
      // All results for one assistant turn go back in a single user message.
      messages.push({ role: 'user', content: results });
    }
  }
}
