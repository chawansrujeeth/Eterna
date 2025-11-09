import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { logger } from '../lib/logger';
import { prisma } from '../lib/db';
import { publishOrderEvent } from '../lib/pubsub';
import { MockDexRouter, sleep } from '../dex/MockDexRouter';
import { bpsDelta } from '../lib/math';

const defaultConnection = () =>
  new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
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

export function createHandler(router = new MockDexRouter()) {
  return async function handleJob(job: Job<ExecuteData>) {
    const { orderId, tokenIn, tokenOut, amount, slippageBps } = job.data;

    // 1) ROUTING
    await setStatus(orderId, 'routing', { details: { candidates: ['Raydium', 'Meteora'] } });
    const [ray, met] = await Promise.all([
      router.getRaydiumQuote(tokenIn, tokenOut, amount),
      router.getMeteoraQuote(tokenIn, tokenOut, amount),
    ]);
    const out1 = amount * ray.price * (1 - ray.fee);
    const out2 = amount * met.price * (1 - met.fee);
    const best = out1 >= out2 ? ray : met;
    await prisma.order.update({ where: { id: orderId }, data: { routeDex: best.dex } });

    // 1.5) Mock wrapped SOL branch (no-op but testable)
    const needsWrap = tokenIn.toUpperCase() === 'SOL' && tokenOut.toUpperCase() !== 'SOL';
    if (needsWrap) {
      await publishOrderEvent({ orderId, status: 'pending', detail: { wrappedSol: true }, ts: Date.now() });
    }

    // 2) BUILDING
    await setStatus(orderId, 'building', { route: { dex: best.dex, expectedPrice: best.price, fee: best.fee } });
    await sleep(150);

    // 3) SUBMITTED
    const txHash = router.generateMockTxHash();
    await setStatus(orderId, 'submitted', { txHash });

    // 4) EXECUTION
    const { executedPrice } = await router.simulateExecution(best.price);
    const usedBps = Math.round(bpsDelta(executedPrice, best.price));

    if (usedBps > slippageBps) {
      const reason = `SLIPPAGE_EXCEEDED: used ${usedBps} bps > allowed ${slippageBps} bps`;
      await prisma.order.update({ where: { id: orderId }, data: { failureReason: reason } });
      await publishOrderEvent({ orderId, status: 'failed', error: reason, ts: Date.now(), lastStep: 'submitted' });
      await prisma.orderEvent.create({ data: { orderId, status: 'failed', payload: { error: reason, lastStep: 'submitted' } } });
      throw new Error(reason);
    }

    const amountOutFinal = amount * executedPrice * (1 - best.fee);
    await prisma.order.update({ where: { id: orderId }, data: { executedPrice, amountOut: amountOutFinal, txHash } });
    await publishOrderEvent({
      orderId,
      status: 'confirmed',
      txHash,
      execution: { executedPrice, amountIn: amount, amountOut: amountOutFinal, slippageBpsUsed: usedBps },
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
  };
}

async function setStatus(orderId: string, status: string, payload: any = {}) {
  await publishOrderEvent({ orderId, status, ts: Date.now(), ...payload });
  await prisma.orderEvent.create({ data: { orderId, status, payload } });
  await prisma.order.update({ where: { id: orderId }, data: { status } });
}

export function startWorker(opts?: { connection?: IORedis; concurrency?: number; handler?: ReturnType<typeof createHandler> }) {
  const connection = opts?.connection ?? defaultConnection();
  const handler = opts?.handler ?? createHandler();
  const worker = new Worker<ExecuteData>('orders', handler, {
    connection,
    concurrency: opts?.concurrency ?? 10,
  });
  worker.on('failed', async (job: any, err: any) => {
    if (!job) return;
    const orderId = job.data.orderId;
    const ord = await prisma.order.findUnique({ where: { id: orderId } });
    if (ord && ord.status !== 'confirmed') {
      const reason = err?.message || 'UNKNOWN_ERROR';
      await prisma.order.update({ where: { id: orderId }, data: { status: 'failed', failureReason: reason } });
      await publishOrderEvent({ orderId, status: 'failed', error: reason, ts: Date.now(), lastStep: ord?.status });
      await prisma.orderEvent.create({ data: { orderId, status: 'failed', payload: { error: reason, lastStep: ord?.status } } });
    }
  });
  return worker;
}

// Dev-only entrypoint
if (process.env.NODE_ENV !== 'test' && require.main === module) {
  startWorker();
  logger.info('Worker up (testable entry)');
  console.log('Worker up (testable entry)');
}
