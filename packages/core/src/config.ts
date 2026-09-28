import { z } from 'zod';

const baseEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required for model calls'),
  MODEL_FAST: z.string().default('claude-sonnet-5'),
  MODEL_STRONG: z.string().default('claude-opus-5-5'),
  // Constrained JSON output (output_config.format). Off until every configured model supports it.
  STRUCTURED_OUTPUTS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const webEnv = baseEnv.extend({
  PORT: z.coerce.number().int().default(3000),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  AUTH_ALLOWED_EMAIL: z.email(),
  AUTH_PASSWORD: z.string().min(12, 'AUTH_PASSWORD must be at least 12 characters'),
});

export type BaseEnv = z.infer<typeof baseEnv>;
export type WebEnv = z.infer<typeof webEnv>;

function parse<T extends z.ZodType>(schema: T, source: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export const loadWorkerEnv = (source = process.env): BaseEnv => parse(baseEnv, source);
export const loadWebEnv = (source = process.env): WebEnv => parse(webEnv, source);
