import { AnthropicLlmClient, JOB_OPTIONS, QUEUE_NAME, loadWorkerEnv } from '@storyforge/core';
import { createDb } from '@storyforge/db';
import {
  type BookReviewJobInput,
  type CohesionJobInput,
  type DraftCardJobInput,
  type ExportJobInput,
  type NovelizeJobInput,
  type OutlineJobInput,
  type ReplanJobInput,
  checkCohesion,
  createServiceContext,
  draftCard,
  exportBook,
  generateOutline,
  novelizeChapter,
  replanOutline,
  reviewBook,
  s3FileStore,
} from '@storyforge/services';
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
  deepen: env.DEEPEN_PASS,
  // Jobs chain follow-up jobs: novelize -> cohesion, lock -> re-plan.
  enqueue: async (job) => {
    await queue.add(job.type, job.data, { ...JOB_OPTIONS, jobId: job.id });
  },
  ...(env.S3_BUCKET
    ? {
        files: s3FileStore({
          bucket: env.S3_BUCKET,
          ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}),
        }),
      }
    : {}),
});

const processor = createProcessor(
  {
    'outline.generate': (jobId, data) => generateOutline(services, jobId, data as OutlineJobInput),
    'character.draftCard': (jobId, data) => draftCard(services, jobId, data as DraftCardJobInput),
    'chapter.novelize': (jobId, data) => novelizeChapter(services, jobId, data as NovelizeJobInput),
    'chapter.cohesion': (jobId, data) => checkCohesion(services, jobId, data as CohesionJobInput),
    'outline.replan': (jobId, data) => replanOutline(services, jobId, data as ReplanJobInput),
    'book.review': (jobId, data) => reviewBook(services, jobId, data as BookReviewJobInput),
    'book.export': (jobId, data) => exportBook(services, jobId, data as ExportJobInput),
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
