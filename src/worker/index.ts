import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import type { Prisma } from '@prisma/client';
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

export class FatalOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalOrderError';
  }
}

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
    const routingDecision = {
      orderId,
      tokenIn,
      tokenOut,
      amount,
      slippageBps,
      candidates: [
        { dex: ray.dex, price: ray.price, fee: ray.fee, estimatedOut: out1 },
        { dex: met.dex, price: met.price, fee: met.fee, estimatedOut: out2 },
      ],
      selected: { dex: best.dex, price: best.price, fee: best.fee, estimatedOut: Math.max(out1, out2) },
    };
    logger.info(routingDecision, 'DEX routing decision');
    console.log('[dex-routing]', routingDecision);
    await prisma.order.update({ where: { id: orderId }, data: { routeDex: best.dex } });

    // 1.5) Mock wrapped SOL branch (no-op but testable)
    const needsWrap = tokenIn.toUpperCase() === 'SOL' && tokenOut.toUpperCase() !== 'SOL';
    if (needsWrap) {
      await safePublishOrderEvent({ orderId, status: 'pending', detail: { wrappedSol: true }, ts: Date.now() });
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
      await setStatus(orderId, 'failed', { error: reason, lastStep: 'submitted' }, { failureReason: reason });
      if (typeof job.discard === 'function') {
        await job.discard();
      }
      throw new FatalOrderError(reason);
    }

    const amountOutFinal = amount * executedPrice * (1 - best.fee);
    await prisma.order.update({
      where: { id: orderId },
      data: { executedPrice, amountOut: amountOutFinal, txHash, status: 'confirmed' },
    });
    await safePublishOrderEvent({
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

async function safePublishOrderEvent(evt: Parameters<typeof publishOrderEvent>[0]) {
  try {
    await publishOrderEvent(evt);
  } catch (err) {
    logger.warn({ err, orderId: evt?.orderId }, 'Failed to publish order event');
  }
}

async function recordRetryAttempt(payload: {
  orderId: string;
  attemptsMade: number;
  maxAttempts: number;
  error: Error | undefined;
}) {
  const retryPayload = {
    error: payload.error?.message || 'UNKNOWN_ERROR',
    attempt: payload.attemptsMade,
    remainingAttempts: Math.max(payload.maxAttempts - payload.attemptsMade, 0),
  };
  await safePublishOrderEvent({ orderId: payload.orderId, status: 'retrying', ...retryPayload });
  try {
    await prisma.orderEvent.create({
      data: {
        orderId: payload.orderId,
        status: 'retrying',
        payload: retryPayload as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    logger.warn({ err, orderId: payload.orderId }, 'Failed to persist retry audit row');
  }
}

async function setStatus(
  orderId: string,
  status: string,
  payload: Record<string, any> = {},
  orderData: Record<string, any> = {},
) {
  const payloadData = payload ?? {};
  const hasPayload = Object.keys(payloadData).length > 0;
  await safePublishOrderEvent({ orderId, status, ts: Date.now(), ...(hasPayload ? payloadData : {}) });
  const eventData: Prisma.OrderEventUncheckedCreateInput = hasPayload
    ? { orderId, status, payload: payloadData as Prisma.InputJsonValue }
    : { orderId, status };
  await prisma.orderEvent.create({ data: eventData });
  await prisma.order.update({ where: { id: orderId }, data: { status, ...orderData } });
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
    const orderId = job.data?.orderId;
    if (!orderId) return;
    const attemptsMade = typeof job.attemptsMade === 'number' ? job.attemptsMade : 0;
    const maxAttempts = typeof job.opts?.attempts === 'number' ? job.opts.attempts : 1;
    const fatal = err instanceof FatalOrderError;
    const exhaustedAttempts = attemptsMade >= maxAttempts;

    if (!fatal && !exhaustedAttempts) {
      await recordRetryAttempt({ orderId, attemptsMade, maxAttempts, error: err });
      return;
    }

    const ord = await prisma.order.findUnique({ where: { id: orderId } });
    if (ord && ord.status !== 'confirmed' && ord.status !== 'failed') {
      const reason = err?.message || 'UNKNOWN_ERROR';
      await setStatus(orderId, 'failed', { error: reason, lastStep: ord?.status }, { failureReason: reason });
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
