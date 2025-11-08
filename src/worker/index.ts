import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { logger } from '../lib/logger';
import { prisma } from '../lib/db';
import { publishOrderEvent } from '../lib/pubsub';
import { MockDexRouter, sleep } from '../dex/MockDexRouter';
import { bpsDelta } from '../lib/math';

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

const router = new MockDexRouter();

async function setStatus(orderId: string, status: string, payload: any = {}) {
  await publishOrderEvent({ orderId, status, ts: Date.now(), ...payload });
  await prisma.orderEvent.create({ data: { orderId, status, payload } });
  await prisma.order.update({ where: { id: orderId }, data: { status } });
}

async function handleJob(job: Job<ExecuteData>) {
  const { orderId, tokenIn, tokenOut, amount, slippageBps } = job.data;
  logger.info({ orderId }, 'Worker picked order');

  // 1) ROUTING
  await setStatus(orderId, 'routing', { details: { candidates: ['Raydium', 'Meteora'] } });
  const [ray, met] = await Promise.all([
    router.getRaydiumQuote(tokenIn, tokenOut, amount),
    router.getMeteoraQuote(tokenIn, tokenOut, amount),
  ]);
  const { best } = router.pickBest(amount, ray, met);
  await prisma.order.update({ where: { id: orderId }, data: { routeDex: best.dex } });

  // 2) BUILDING
  await setStatus(orderId, 'building', { route: { dex: best.dex, expectedPrice: best.price, fee: best.fee } });
  await sleep(300 + Math.random() * 400);

  // 3) SUBMITTED
  const txHash = router.generateMockTxHash();
  await setStatus(orderId, 'submitted', { txHash });

  // 4) EXECUTION (simulate on-chain)
  const { executedPrice } = await router.simulateExecution(best.price);
  const usedBps = Math.round(bpsDelta(executedPrice, best.price));

  // Slippage protection
  if (usedBps > slippageBps) {
    const failureReason = `SLIPPAGE_EXCEEDED: used ${usedBps} bps > allowed ${slippageBps} bps`;
    // mark failed, but still throw to let BullMQ count attempt
    await prisma.order.update({ where: { id: orderId }, data: { failureReason } });
    await publishOrderEvent({ orderId, status: 'failed', error: failureReason, ts: Date.now(), lastStep: 'submitted' });
    await prisma.orderEvent.create({
      data: { orderId, status: 'failed', payload: { error: failureReason, lastStep: 'submitted' } },
    });
    throw new Error(failureReason);
  }

  const amountOutFinal = amount * executedPrice * (1 - best.fee);

  // SUCCESS
  await prisma.order.update({
    where: { id: orderId },
    data: { executedPrice, amountOut: amountOutFinal, txHash },
  });

  await publishOrderEvent({
    orderId,
    status: 'confirmed',
    txHash,
    execution: {
      executedPrice,
      amountIn: amount,
      amountOut: amountOutFinal,
      slippageBpsUsed: usedBps,
    },
    route: { dex: best.dex, expectedPrice: best.price, fee: best.fee },
    ts: Date.now(),
  });

  await prisma.orderEvent.create({
    data: {
      orderId,
      status: 'confirmed',
      payload: {
        txHash,
        execution: { executedPrice, amountIn: amount, amountOut: amountOutFinal, slippageBpsUsed: usedBps },
        route: { dex: best.dex, expectedPrice: best.price, fee: best.fee },
      },
    },
  });

  return true;
}

// Final failure handler (after all attempts)
const worker = new Worker<ExecuteData>('orders', handleJob, { connection, concurrency: 10 });

worker.on('failed', async (job, err) => {
  if (!job) return;
  const orderId = job.data.orderId;
  // Only set failed if not already confirmed
  const ord = await prisma.order.findUnique({ where: { id: orderId } });
  if (ord && ord.status !== 'confirmed') {
    const reason = err?.message || 'UNKNOWN_ERROR';
    await prisma.order.update({ where: { id: orderId }, data: { status: 'failed', failureReason: reason } });
    await publishOrderEvent({ orderId, status: 'failed', error: reason, ts: Date.now(), lastStep: ord?.status });
    await prisma.orderEvent.create({
      data: { orderId, status: 'failed', payload: { error: reason, lastStep: ord?.status } },
    });
  }
});

logger.info('Worker up (full lifecycle)');
setInterval(() => {}, 1 << 30);
