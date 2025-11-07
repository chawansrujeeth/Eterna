import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { logger } from '../lib/logger';
import { orderBus } from '../lib/bus';
import { prisma } from '../lib/db';

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

type ExecuteData = {
  orderId: string;
  tokenIn: string;
  tokenOut: string;
  amount: number;
  slippageBps: number;
  orderType: 'market';
};

async function handleJob(job: Job<ExecuteData>) {
  const { orderId } = job.data;
  logger.info({ orderId, data: job.data }, 'Worker: picked order');

  // publish "routing" just to prove WS works end-to-end
  const evt = { orderId, status: 'routing', ts: Date.now(), details: { candidates: ['Raydium', 'Meteora'] } };
  orderBus.publish(orderId, evt);

  await prisma.orderEvent.create({ data: { orderId, status: 'routing', payload: evt.details } });
  await prisma.order.update({ where: { id: orderId }, data: { status: 'routing' } });

  // (Next steps will be implemented later: quotes, building, submitted, confirmed/failed)
  return true;
}

new Worker<ExecuteData>('orders', handleJob, {
  connection,
  concurrency: 10,
});

logger.info('Worker up (placeholder)');
setInterval(() => {}, 1 << 30);
