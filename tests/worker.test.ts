import { createHandler, startWorker } from '../src/worker';
import { prisma } from '../src/lib/db';
import { publishOrderEvent } from '../src/lib/pubsub';
import { ordersQueue } from '../src/lib/queue';

jest.mock('bullmq', () => {
  class MockWorker {
    public handlers: Record<string, (...args: any[]) => Promise<void> | void> = {};
    public queue: any[] = [];
    public active = 0;

    constructor(
      public name: string,
      public handler: (...args: any[]) => Promise<void> | void,
      public opts: any,
    ) {}

    on(event: string, cb: (...args: any[]) => Promise<void> | void) {
      this.handlers[event] = cb;
      return this;
    }

    pushJob(job: any) {
      this.queue.push(job);
      this.drain();
      return job;
    }

    drain() {
      while (this.active < (this.opts?.concurrency ?? 1) && this.queue.length) {
        const nextJob = this.queue.shift()!;
        this.active++;
        Promise.resolve(this.handler(nextJob))
          .then(() => this.finish(nextJob))
          .catch((err) => {
            this.finish(nextJob);
            const failed = this.handlers.failed;
            if (failed) failed(nextJob, err);
          });
      }
    }

    finish(job: any) {
      this.active = Math.max(0, this.active - 1);
      this.drain();
    }
  }

  class MockQueue {
    constructor(public name: string, public opts: any) {}
    async add() {
      return {};
    }
  }

  return { Worker: MockWorker, Queue: MockQueue };
});

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    quit: jest.fn(),
  }));
});

jest.mock('../src/lib/db', () => ({
  prisma: {
    order: {
      update: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    orderEvent: {
      create: jest.fn().mockResolvedValue(null),
    },
  },
}));

jest.mock('../src/lib/pubsub', () => ({
  publishOrderEvent: jest.fn().mockResolvedValue(undefined),
}));

describe('worker handler', () => {
  const baseJob = {
    orderId: 'order-123',
    tokenIn: 'BTC',
    tokenOut: 'USDC',
    amount: 2,
    slippageBps: 75,
    orderType: 'market' as const,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('slippage fails when exceeded', async () => {
    const router = {
      getRaydiumQuote: jest.fn().mockResolvedValue({ dex: 'Raydium', price: 100, fee: 0.003 }),
      getMeteoraQuote: jest.fn().mockResolvedValue({ dex: 'Meteora', price: 95, fee: 0.003 }),
      generateMockTxHash: jest.fn().mockReturnValue('0xtest'),
      simulateExecution: jest.fn().mockResolvedValue({ executedPrice: 112 }),
    };

    const handler = createHandler(router as any);
    const discard = jest.fn();
    const job: any = { data: { ...baseJob, orderId: 'order-fail', slippageBps: 50 }, discard };

    await expect(handler(job)).rejects.toThrow(/SLIPPAGE_EXCEEDED/);

    const prismaMock = prisma as any;
    expect(prismaMock.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-fail' },
        data: expect.objectContaining({
          failureReason: expect.stringContaining('SLIPPAGE_EXCEEDED'),
          status: 'failed',
        }),
      }),
    );
    expect(discard).toHaveBeenCalledTimes(1);

    const publishMock = jest.mocked(publishOrderEvent);
    const statuses = publishMock.mock.calls.map(([evt]) => evt.status);
    expect(statuses[statuses.length - 1]).toBe('failed');
  });

  test('status order is correct for success path', async () => {
    const router = {
      getRaydiumQuote: jest.fn().mockResolvedValue({ dex: 'Raydium', price: 100, fee: 0.003 }),
      getMeteoraQuote: jest.fn().mockResolvedValue({ dex: 'Meteora', price: 99, fee: 0.004 }),
      generateMockTxHash: jest.fn().mockReturnValue('0xsuccess'),
      simulateExecution: jest.fn().mockResolvedValue({ executedPrice: 100.1 }),
    };

    const handler = createHandler(router as any);
    const job: any = { data: { ...baseJob, orderId: 'order-success' } };

    await expect(handler(job)).resolves.toBe(true);

    const publishMock = jest.mocked(publishOrderEvent);
    const statuses = publishMock.mock.calls.map(([evt]) => evt.status);
    expect(statuses).toEqual(['routing', 'building', 'submitted', 'confirmed']);
  });

  test('load test: 15 orders reach terminal states', async () => {
    const router = {
      getRaydiumQuote: jest.fn().mockResolvedValue({ dex: 'Raydium', price: 100, fee: 0.003 }),
      getMeteoraQuote: jest.fn().mockResolvedValue({ dex: 'Meteora', price: 99.5, fee: 0.003 }),
      generateMockTxHash: jest.fn().mockReturnValue('0xbulk'),
      simulateExecution: jest.fn().mockResolvedValue({ executedPrice: 100 }),
    };

    const handler = createHandler(router as any);
    const orderIds = Array.from({ length: 15 }, (_, idx) => `order-batch-${idx + 1}`);
    const jobs = orderIds.map((orderId, idx) => ({
      data: { ...baseJob, orderId, amount: baseJob.amount + idx * 0.1 },
    }));

    await Promise.all(jobs.map((job) => handler(job as any)));

    expect(router.getRaydiumQuote).toHaveBeenCalledTimes(orderIds.length);
    expect(router.getMeteoraQuote).toHaveBeenCalledTimes(orderIds.length);
    expect(router.simulateExecution).toHaveBeenCalledTimes(orderIds.length);

    const publishMock = jest.mocked(publishOrderEvent);
    const statusesByOrder = new Map<string, string[]>();
    for (const [evt] of publishMock.mock.calls) {
      if (!evt?.orderId) continue;
      const list = statusesByOrder.get(evt.orderId) ?? [];
      list.push(evt.status);
      statusesByOrder.set(evt.orderId, list);
    }
    expect(statusesByOrder.size).toBe(orderIds.length);
    for (const id of orderIds) {
      const statuses = statusesByOrder.get(id) ?? [];
      const terminal = [...statuses].reverse().find((s) => s === 'confirmed' || s === 'failed');
      expect(terminal).toBe('confirmed');
    }

    const prismaMock = prisma as any;
    const confirmedUpdates = (prismaMock.order.update as jest.Mock).mock.calls.filter(
      ([args]: any) => args?.data?.status === 'confirmed',
    );
    expect(confirmedUpdates).toHaveLength(orderIds.length);
  });

  test('wrapped SOL branch emits pending detail', async () => {
    const router = {
      getRaydiumQuote: jest.fn().mockResolvedValue({ dex: 'Raydium', price: 101, fee: 0.002 }),
      getMeteoraQuote: jest.fn().mockResolvedValue({ dex: 'Meteora', price: 100, fee: 0.003 }),
      generateMockTxHash: jest.fn().mockReturnValue('0xwrap'),
      simulateExecution: jest.fn().mockResolvedValue({ executedPrice: 101 }),
    };

    const handler = createHandler(router as any);
    const job: any = { data: { ...baseJob, orderId: 'order-sol', tokenIn: 'SOL', tokenOut: 'USDC' } };

    await expect(handler(job)).resolves.toBe(true);

    const publishMock = jest.mocked(publishOrderEvent);
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order-sol',
        status: 'pending',
        detail: { wrappedSol: true },
      }),
    );
  });

  test('retry stops at 3 and final status is failed', async () => {
    const worker = startWorker({ connection: {} as any, handler: jest.fn() as any });
    const failedHandler = (worker as any).handlers.failed as (job: any, err: Error) => Promise<void>;
    expect(typeof failedHandler).toBe('function');

    (prisma.order.findUnique as jest.Mock).mockResolvedValueOnce({ id: 'order-retry', status: 'submitted' });
    const job = { data: { orderId: 'order-retry' }, attemptsMade: 3, opts: { attempts: 3 } } as any;
    const err = new Error('boom');

    await failedHandler(job, err);

    const prismaMock = prisma as any;
    expect(prismaMock.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-retry' },
        data: expect.objectContaining({ status: 'failed', failureReason: 'boom' }),
      }),
    );
    expect(prismaMock.orderEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: 'order-retry',
          status: 'failed',
          payload: expect.objectContaining({ error: 'boom', lastStep: 'submitted' }),
        }),
      }),
    );

    const publishMock = jest.mocked(publishOrderEvent);
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-retry', status: 'failed', error: 'boom', lastStep: 'submitted' }),
    );

    const queueOpts = (ordersQueue as any).opts;
    expect(queueOpts.defaultJobOptions.attempts).toBe(3);
  });

  test('transient failures emit retrying events without marking the order failed', async () => {
    const worker = startWorker({ connection: {} as any, handler: jest.fn() as any });
    const failedHandler = (worker as any).handlers.failed as (job: any, err: Error) => Promise<void>;
    const publishMock = jest.mocked(publishOrderEvent);

    publishMock.mockClear();
    (prisma.orderEvent.create as jest.Mock).mockClear();
    (prisma.order.findUnique as jest.Mock).mockClear();
    (prisma.order.update as jest.Mock).mockClear();

    const job = { data: { orderId: 'order-retry' }, attemptsMade: 1, opts: { attempts: 3 } } as any;
    const err = new Error('redis hiccup');

    await failedHandler(job, err);

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order-retry',
        status: 'retrying',
        error: 'redis hiccup',
        attempt: 1,
        remainingAttempts: 2,
      }),
    );
    expect(prisma.orderEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: 'order-retry',
          status: 'retrying',
          payload: expect.objectContaining({ attempt: 1, remainingAttempts: 2 }),
        }),
      }),
    );
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  test('queue concurrency enforced (mock timers)', async () => {
    jest.useFakeTimers();
    try {
      let concurrent = 0;
      let peakConcurrent = 0;
      const handler = jest.fn(async () => {
        concurrent++;
        peakConcurrent = Math.max(peakConcurrent, concurrent);
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            concurrent--;
            resolve();
          }, 500);
        });
      });

      const worker = startWorker({ connection: {} as any, concurrency: 2, handler: handler as any });
      const mockWorker = worker as any;

      mockWorker.pushJob({ data: { id: 'job-1' } });
      mockWorker.pushJob({ data: { id: 'job-2' } });
      mockWorker.pushJob({ data: { id: 'job-3' } });

      expect(handler).toHaveBeenCalledTimes(2);
      expect(peakConcurrent).toBe(2);

      jest.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();

      expect(handler).toHaveBeenCalledTimes(3);
      expect(peakConcurrent).toBe(2);

      jest.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();

      expect(peakConcurrent).toBeLessThanOrEqual(2);
      expect(handler).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });
});
