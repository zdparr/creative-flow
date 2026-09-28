import type { TokenUsage } from './client.js';

/** USD per million tokens (Anthropic first-party rates). Unknown models cost 0 and should be added here. */
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-fable-5-1': { input: 10, output: 50 },
};

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export function costUsd(model: string, usage: TokenUsage): number {
  const price = PRICES[model];
  if (!price) return 0;
  const uncached = usage.inputTokens - usage.cacheWriteTokens;
  const input =
    uncached * price.input +
    usage.cacheWriteTokens * price.input * CACHE_WRITE_MULTIPLIER +
    usage.cacheReadTokens * price.input * CACHE_READ_MULTIPLIER;
  return (input + usage.outputTokens * price.output) / 1_000_000;
}
