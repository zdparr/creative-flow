import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWebEnv } from '@storyforge/core';
import { createDb, createUserRepo } from '@storyforge/db';
import { buildApp } from './app.js';

const env = loadWebEnv();
const { db, sql, close } = createDb(env.DATABASE_URL);

const app = await buildApp({
  env,
  pingDb: async () => {
    await sql`select 1`;
  },
  users: createUserRepo(db),
  webDist: resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist'),
  logger: env.NODE_ENV === 'production' ? true : { level: 'info' },
});

const shutdown = async () => {
  await app.close();
  await close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: env.PORT, host: '0.0.0.0' });
