import Fastify from 'fastify';
import { registerRoutes } from '../src/api/routes';
import { prisma } from '../src/lib/db';
import { getOrSetIdempotency } from '../src/lib/idempotency';

jest.mock('../src/lib/queue', () => ({
  ordersQueue: { add: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../src/lib/rate', () => ({
  allowOrderCreate: jest.fn().mockResolvedValue({ allowed: true, count: 0, limit: 120 }),
}));

jest.mock('../src/lib/idempotency', () => ({
  getOrSetIdempotency: jest.fn(),
}));

jest.mock('../src/lib/pubsub', () => ({
  publishOrderEvent: jest.fn().mockResolvedValue(undefined),
  subscribeOrderEvents: jest.fn(),
}));

jest.mock('../src/lib/db', () => ({
  prisma: {
    order: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    orderEvent: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
    },
  },
}));

const mockedPrisma = prisma as any;
const mockedIdempotency = getOrSetIdempotency as jest.MockedFunction<typeof getOrSetIdempotency>;
const idempotencyStore = new Map<string, string>();

beforeEach(() => {
  jest.clearAllMocks();
  idempotencyStore.clear();
  mockedIdempotency.mockImplementation(async (key: string, orderId?: string) => {
    if (idempotencyStore.has(key)) {
      return idempotencyStore.get(key)!;
    }
    if (orderId) {
      idempotencyStore.set(key, orderId);
      return orderId;
    }
    return null;
  });
});

async function buildApp() {
  const app = Fastify({
    logger: false,
    ajv: {
      customOptions: {
        strict: false,
      },
    },
  });
  await registerRoutes(app);
  return app;
}

describe('GET /api/orders/:orderId', () => {
  test('returns order details with event history', async () => {
    const createdAt = new Date('2024-01-01T00:00:00Z');
    const updatedAt = new Date('2024-01-01T00:05:00Z');
    mockedPrisma.order.findUnique.mockResolvedValueOnce({
      id: 'order-1',
      type: 'market',
      tokenIn: 'SOL',
      tokenOut: 'USDC',
      amount: 1,
      slippageBps: 50,
      status: 'confirmed',
      routeDex: 'Raydium',
      executedPrice: 150,
      amountOut: 149,
      txHash: '0xabc',
      failureReason: null,
      createdAt,
      updatedAt,
    });
    mockedPrisma.orderEvent.findMany.mockResolvedValueOnce([
      {
        id: 'evt-1',
        orderId: 'order-1',
        status: 'routing',
        payload: { step: 'routing' },
        createdAt,
      },
      {
        id: 'evt-2',
        orderId: 'order-1',
        status: 'confirmed',
        payload: { txHash: '0xabc' },
        createdAt: updatedAt,
      },
    ]);

    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/orders/order-1' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.order.id).toBe('order-1');
      expect(body.order.createdAt).toBe(createdAt.toISOString());
      expect(body.events).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  test('returns 404 when order missing', async () => {
    mockedPrisma.order.findUnique.mockResolvedValueOnce(null);

    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/orders/missing' });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found', message: 'Order not found' });
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/orders/execute', () => {
  test('persists order and initial event rows', async () => {
    const app = await buildApp();
    try {
      const payload = {
        orderType: 'market',
        tokenIn: 'SOL',
        tokenOut: 'USDC',
        amount: 1.25,
        slippageBps: 40,
      };

      const res = await app.inject({ method: 'POST', url: '/api/orders/execute', payload });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual({ orderId: expect.any(String), idempotent: false });

      expect(mockedPrisma.order.create).toHaveBeenCalledTimes(1);
      expect(mockedPrisma.orderEvent.create).toHaveBeenCalledTimes(1);

      const orderArgs = mockedPrisma.order.create.mock.calls[0][0];
      expect(orderArgs).toEqual({
        data: expect.objectContaining({
          id: body.orderId,
          type: 'market',
          tokenIn: payload.tokenIn,
          tokenOut: payload.tokenOut,
          amount: payload.amount,
          slippageBps: payload.slippageBps,
          status: 'pending',
        }),
      });

      const eventArgs = mockedPrisma.orderEvent.create.mock.calls[0][0];
      expect(eventArgs).toEqual({
        data: {
          orderId: body.orderId,
          status: 'pending',
          payload: { source: 'api' },
        },
      });
    } finally {
      await app.close();
    }
  });

  test('reuses orderId when clientToken idempotency header repeats', async () => {
    const app = await buildApp();
    try {
      const payload = {
        orderType: 'market',
        tokenIn: 'SOL',
        tokenOut: 'USDC',
        amount: 2.5,
      };
      const headers = { clientToken: 'client-123' };

      const first = await app.inject({ method: 'POST', url: '/api/orders/execute', payload, headers });
      expect(first.statusCode).toBe(200);
      const firstBody = first.json();
      expect(firstBody).toEqual({ orderId: expect.any(String), idempotent: false });

      const second = await app.inject({ method: 'POST', url: '/api/orders/execute', payload, headers });
      expect(second.statusCode).toBe(200);
      const secondBody = second.json();
      expect(secondBody).toEqual({ orderId: firstBody.orderId, idempotent: true });

      expect(mockedPrisma.order.create).toHaveBeenCalledTimes(1);
      expect(mockedPrisma.orderEvent.create).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
