import { AnthropicLlmClient, JOB_OPTIONS, QUEUE_NAME, loadWorkerEnv } from '@storyforge/core';
import { createDb } from '@storyforge/db';
import { type OutlineJobInput, createServiceContext, generateOutline } from '@storyforge/services';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createProcessor } from './processor.js';

const env = loadWorkerEnv();

// BullMQ requires maxRetriesPerRequest: null on worker connections.
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(QUEUE_NAME, { connection });
const { db, close } = createDb(env.DATABASE_URL);

const services = createServiceContext({
  db,
  llm: new AnthropicLlmClient({
    apiKey: env.ANTHROPIC_API_KEY,
    models: { fast: env.MODEL_FAST, strong: env.MODEL_STRONG },
    structuredOutputs: env.STRUCTURED_OUTPUTS,
  }),
  // Jobs can chain follow-up jobs (novelize -> cohesion from Phase 5).
  enqueue: async (job) => {
    await queue.add(job.type, job.data, { ...JOB_OPTIONS, jobId: job.id });
  },
});

const processor = createProcessor(
  {
    'outline.generate': (jobId, data) => generateOutline(services, jobId, data as OutlineJobInput),
  },
  services.repos.jobs,
);

const worker = new Worker(QUEUE_NAME, processor, { connection, concurrency: 2 });

worker.on('ready', () => console.log(`worker listening on queue "${QUEUE_NAME}"`));
worker.on('failed', (job, err) =>
  console.error(`job ${job?.id} (${job?.name}) failed:`, err.message),
);

const shutdown = async () => {
  await worker.close();
  await queue.close();
  await connection.quit();
  await close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
