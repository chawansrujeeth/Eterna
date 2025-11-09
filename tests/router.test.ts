import { MockDexRouter } from '../src/dex/MockDexRouter';
import { handleOrderWebSocket } from '../src/api/ws';
import { prisma } from '../src/lib/db';
import { subscribeOrderEvents } from '../src/lib/pubsub';

jest.mock('../src/lib/db', () => ({
  prisma: {
    orderEvent: {
      findMany: jest.fn(),
    },
  },
}));

jest.mock('../src/lib/pubsub', () => ({
  subscribeOrderEvents: jest.fn(),
}));

test('pick best quote considering fees', async () => {
  const r = new MockDexRouter();
  const amount = 2;

  const ray = { dex: 'Raydium', price: 100, fee: 0.003 } as any;
  const met = { dex: 'Meteora', price: 100, fee: 0.010 } as any; // same price, worse fee
  const out1 = amount * ray.price * (1 - ray.fee);
  const out2 = amount * met.price * (1 - met.fee);
  expect(out1 > out2).toBe(true);
  const { best } = r.pickBest(amount, ray, met);
  expect(best).toBe(ray);
});

describe('handleOrderWebSocket', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('WS delivers all events for an order', async () => {
    const orderId = 'order-ws';
    const sent: string[] = [];
    const wsHandlers: Record<string, (...args: any[]) => void> = {};
    const fakeWs = {
      send: jest.fn((payload: string) => {
        sent.push(payload);
      }),
      on: jest.fn((event: string, cb: (...args: any[]) => void) => {
        wsHandlers[event] = cb;
      }),
      close: jest.fn(),
    } as any;

    const history = [
      { orderId, status: 'routing', payload: { step: 'routing' }, createdAt: new Date('2024-01-01T00:00:00Z') },
      { orderId, status: 'building', payload: { step: 'building' }, createdAt: new Date('2024-01-01T00:00:05Z') },
    ];
    (prisma.orderEvent.findMany as jest.Mock).mockResolvedValueOnce(history);

    let liveCallback: ((evt: any) => void) | undefined;
    (subscribeOrderEvents as jest.Mock).mockImplementation(async (_orderId: string, cb: (evt: any) => void) => {
      liveCallback = cb;
      return jest.fn();
    });

    await handleOrderWebSocket(fakeWs, { url: `/api/orders/execute?orderId=${orderId}` } as any);

    expect(fakeWs.send).toHaveBeenCalled();
    const parsed = sent.map((msg) => JSON.parse(msg));
    expect(parsed[0]).toEqual({ orderId, status: 'ws_connected', ts: expect.any(Number) });
    expect(parsed[1]).toEqual({
      orderId,
      status: 'routing',
      payload: { step: 'routing' },
      ts: history[0].createdAt.getTime(),
      replay: true,
    });
    expect(parsed[2]).toEqual({
      orderId,
      status: 'building',
      payload: { step: 'building' },
      ts: history[1].createdAt.getTime(),
      replay: true,
    });

    expect(subscribeOrderEvents).toHaveBeenCalledWith(orderId, expect.any(Function));
    expect(liveCallback).toBeDefined();

    const liveEvent = { orderId, status: 'confirmed', ts: 999, txHash: '0xabc' };
    liveCallback?.(liveEvent);

    const latest = JSON.parse(sent[sent.length - 1]);
    expect(latest).toEqual(liveEvent);

    expect(wsHandlers.close).toBeDefined();
  });
});
