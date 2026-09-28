import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';

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

/** The seam every agent calls through; tests substitute a fake that replays fixtures. */
export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
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

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicLlmOptions) {
    this.client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const model = this.options.models[request.tier];
    // Streaming avoids HTTP timeouts on long outputs; finalMessage() assembles the result.
    const stream = this.client.messages.stream({
      model,
      max_tokens: request.maxTokens,
      // The system prompt is the stable prefix, so it is the cache breakpoint.
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      messages: request.messages,
      thinking: { type: 'adaptive' },
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
    const text = message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('');
    const cacheWrite = message.usage.cache_creation_input_tokens ?? 0;
    return {
      text,
      model: message.model,
      stopReason: message.stop_reason,
      usage: {
        inputTokens: message.usage.input_tokens + cacheWrite,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: cacheWrite,
      },
    };
  }
}
