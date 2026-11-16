import { Worker } from 'bullmq';
import { BRAND } from '@assessiq/shared';
import { QUEUES } from './queues';

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  console.error(
    'REDIS_URL is not set. Copy .env.example to .env and start Redis (npm run infra:up).',
  );
  process.exit(1);
}

const url = new URL(redisUrl);
const connection = {
  host: url.hostname,
  port: Number(url.port || 6379),
  password: url.password || undefined,
  maxRetriesPerRequest: null as null,
};

// Placeholder consumers. Real processors arrive in later sprints.
const workers = Object.values(QUEUES).map(
  (name) =>
    new Worker(
      name,
      async (job) => {
        console.log(`[${name}] job ${job.id} received (no processor implemented yet)`);
      },
      { connection },
    ),
);

console.log(`${BRAND.PRODUCT} worker started, listening on: ${Object.values(QUEUES).join(', ')}`);

async function shutdown() {
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
