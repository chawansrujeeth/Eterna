import Fastify from 'fastify';
import { registerRoutes } from '../src/api/routes';
import { prisma } from '../src/lib/db';

jest.mock('../src/lib/queue', () => ({
  ordersQueue: { add: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../src/lib/rate', () => ({
  allowOrderCreate: jest.fn().mockResolvedValue({ allowed: true, count: 0, limit: 120 }),
}));

jest.mock('../src/lib/idempotency', () => ({
  getOrSetIdempotency: jest.fn().mockResolvedValue(undefined),
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
  beforeEach(() => {
    jest.clearAllMocks();
  });

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
