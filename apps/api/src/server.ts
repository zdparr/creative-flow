import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnthropicLlmClient, JOB_OPTIONS, QUEUE_NAME, loadWebEnv } from '@storyforge/core';
import { createDb } from '@storyforge/db';
import { createServiceContext } from '@storyforge/services';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { buildApp } from './app.js';

const env = loadWebEnv();
const { db, sql, close } = createDb(env.DATABASE_URL);
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(QUEUE_NAME, { connection });

const services = createServiceContext({
  db,
  llm: new AnthropicLlmClient({
    apiKey: env.ANTHROPIC_API_KEY,
    models: { fast: env.MODEL_FAST, strong: env.MODEL_STRONG },
    structuredOutputs: env.STRUCTURED_OUTPUTS,
  }),
  enqueue: async (job) => {
    await queue.add(job.type, job.data, { ...JOB_OPTIONS, jobId: job.id });
  },
});

const app = await buildApp({
  env,
  pingDb: async () => {
    await sql`select 1`;
  },
  services,
  webDist: resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist'),
  logger: env.NODE_ENV === 'production' ? true : { level: 'info' },
});

const shutdown = async () => {
  await app.close();
  await queue.close();
  await connection.quit();
  await close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: env.PORT, host: '0.0.0.0' });
