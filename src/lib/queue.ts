import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const ordersQueueConnection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null, // required by BullMQ for blocking connections
});

export const ordersQueue = new Queue('orders', {
  connection: ordersQueueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 500 },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

let queueClosed = false;

export async function shutdownOrdersQueue() {
  if (queueClosed) return;
  queueClosed = true;

  try {
    await ordersQueue.close();
  } catch {
    // ignore close errors so shutdown path is always attempted
  }

  if (typeof ordersQueueConnection.quit === 'function') {
    try {
      await ordersQueueConnection.quit();
    } catch {
      // ignore quit errors during shutdown
    }
  }
}
