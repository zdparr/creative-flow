import { QUEUE_NAME, loadWorkerEnv } from '@storyforge/core';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { processJob } from './processor.js';

const env = loadWorkerEnv();

// BullMQ requires maxRetriesPerRequest: null on worker connections.
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const worker = new Worker(QUEUE_NAME, (job) => processJob(job.name, job.data), {
  connection,
  concurrency: 2,
});

worker.on('ready', () => console.log(`worker listening on queue "${QUEUE_NAME}"`));
worker.on('failed', (job, err) => console.error(`job ${job?.id} (${job?.name}) failed:`, err));

const shutdown = async () => {
  await worker.close();
  await connection.quit();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
