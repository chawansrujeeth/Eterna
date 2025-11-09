import { ordersQueue, shutdownOrdersQueue } from '../src/lib/queue';

afterAll(async () => {
  await shutdownOrdersQueue();
});

describe('orders queue configuration', () => {
  test('failed jobs get up to three retries with exponential backoff', () => {
    const opts = (ordersQueue as any).opts?.defaultJobOptions;
    expect(opts?.attempts).toBe(3);
    expect(opts?.backoff).toEqual({ type: 'exponential', delay: 500 });
    expect(opts?.removeOnFail).toBe(false);
  });
});
