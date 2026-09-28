import type { LlmClient, LlmRequest, LlmResponse, StreamRequest } from '../llm/client.js';

/** A scripted streamed response: optional tool calls first, then prose in chunks. */
export interface FakeStream {
  stream: string[];
  toolCalls?: { name: string; input: unknown }[];
}

const isStream = (x: unknown): x is FakeStream =>
  typeof x === 'object' && x !== null && Array.isArray((x as FakeStream).stream);

/**
 * Replays scripted responses in order, recording each request. For `complete`, pass objects
 * to have them serialized as JSON, or strings to return raw text (useful for testing invalid
 * output). For `stream`, pass a FakeStream.
 */
export class FakeLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];
  /** Tool results returned to the model, in call order. */
  readonly toolResults: string[] = [];

  constructor(private readonly responses: unknown[] = []) {}

  push(...responses: unknown[]): this {
    this.responses.push(...responses);
    return this;
  }

  private next(request: LlmRequest): unknown {
    this.requests.push(request);
    if (this.responses.length === 0) throw new Error('FakeLlm has no scripted response left');
    return this.responses.shift();
  }

  private response(request: LlmRequest, text: string): LlmResponse {
    return {
      text,
      model: request.tier === 'fast' ? 'claude-sonnet-5' : 'claude-opus-5-5',
      stopReason: 'end_turn',
      usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const next = this.next(request);
    if (isStream(next)) throw new Error('FakeLlm: expected a complete() response, got a stream');
    return this.response(request, typeof next === 'string' ? next : JSON.stringify(next));
  }

  async stream(request: StreamRequest): Promise<LlmResponse> {
    const next = this.next(request);
    if (!isStream(next)) throw new Error('FakeLlm: expected a stream() response');
    for (const call of next.toolCalls ?? []) {
      const tool = request.tools?.find((t) => t.name === call.name);
      if (!tool) throw new Error(`FakeLlm: unknown tool ${call.name}`);
      this.toolResults.push(await tool.run(tool.inputSchema.parse(call.input)));
    }
    for (const chunk of next.stream) request.onText(chunk);
    return this.response(request, next.stream.join(''));
  }
}
