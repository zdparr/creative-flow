import type { LlmClient, LlmRequest, LlmResponse } from '../llm/client.js';

/**
 * Replays scripted responses in order, recording each request. Pass objects to have them
 * serialized as JSON, or strings to return raw text (useful for testing invalid output).
 */
export class FakeLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly responses: (unknown | string)[] = []) {}

  push(...responses: (unknown | string)[]): this {
    this.responses.push(...responses);
    return this;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    if (this.responses.length === 0) throw new Error('FakeLlm has no scripted response left');
    const next = this.responses.shift();
    return {
      text: typeof next === 'string' ? next : JSON.stringify(next),
      model: request.tier === 'fast' ? 'claude-sonnet-5' : 'claude-opus-5-5',
      stopReason: 'end_turn',
      usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}
