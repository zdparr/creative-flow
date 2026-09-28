import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { LoadedPrompt } from '../prompts/loader.js';
import type { LlmClient, ModelTier } from './client.js';
import { costUsd } from './pricing.js';

export interface LlmCallLog {
  agent: string;
  promptVersion: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
}

/** What every agent needs from its caller: a model client and a sink for cost logging. */
export interface AgentContext {
  llm: LlmClient;
  onCall: (log: LlmCallLog) => Promise<void> | void;
}

export class AgentOutputError extends Error {
  constructor(
    readonly agent: string,
    readonly problems: string[],
  ) {
    super(`${agent} produced invalid output after a retry:\n- ${problems.join('\n- ')}`);
    this.name = 'AgentOutputError';
  }
}

/** Pulls the JSON object out of a response, tolerating code fences or stray prose. */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) throw new Error('Response contained no JSON object');
  return JSON.parse(text.slice(start, end + 1));
}

export interface StructuredAgentCall<T> {
  agent: string;
  prompt: LoadedPrompt;
  tier: ModelTier;
  messages: Anthropic.MessageParam[];
  schema: z.ZodType<T>;
  maxTokens: number;
  /** Domain checks beyond the schema; return problems, empty when valid. */
  check?: (value: T) => string[];
}

/**
 * The system prompt plus the exact JSON Schema the answer must match. Without it the model
 * has to guess field names. It is appended to the system prompt so it stays in the cached prefix.
 */
export function systemWithSchema(system: string, schema: z.ZodType): string {
  const jsonSchema = JSON.stringify(z.toJSONSchema(schema), null, 2);
  return `${system}

## Output format

Respond with a single JSON object, and nothing else, that validates against this JSON Schema. Include every required field and use the field names exactly as written.

${jsonSchema}`;
}

/**
 * Calls the model for a JSON result. Invalid output (unparseable, schema failure, or a
 * failed domain check) retries once with the problems appended, then throws AgentOutputError.
 */
export async function runStructuredAgent<T>(
  ctx: AgentContext,
  call: StructuredAgentCall<T>,
): Promise<T> {
  let messages = call.messages;
  let problems: string[] = [];
  const system = systemWithSchema(call.prompt.system, call.schema);

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await ctx.llm.complete({
      tier: call.tier,
      system,
      messages,
      maxTokens: call.maxTokens,
      outputSchema: call.schema,
    });
    await ctx.onCall({
      agent: call.agent,
      promptVersion: call.prompt.version,
      model: response.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cachedTokens: response.usage.cacheReadTokens,
      costUsd: costUsd(response.model, response.usage),
    });

    problems = validate(response.text, response.stopReason, call);
    if (problems.length === 0) return call.schema.parse(extractJson(response.text));

    messages = [
      ...messages,
      { role: 'assistant', content: response.text || '(empty response)' },
      {
        role: 'user',
        content: `That output was invalid:\n- ${problems.join('\n- ')}\n\nReturn the complete corrected JSON object only.`,
      },
    ];
  }
  throw new AgentOutputError(call.agent, problems);
}

function validate<T>(
  text: string,
  stopReason: string | null,
  call: StructuredAgentCall<T>,
): string[] {
  if (stopReason === 'max_tokens')
    return ['The response was cut off at the token limit; be more concise'];
  let json: unknown;
  try {
    json = extractJson(text);
  } catch (err) {
    return [`Not valid JSON: ${(err as Error).message}`];
  }
  const parsed = call.schema.safeParse(json);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  }
  return call.check?.(parsed.data) ?? [];
}
