import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db';
import { ordersQueue } from '../lib/queue';
import { publishOrderEvent } from '../lib/pubsub';
import { handleOrderWebSocket } from './ws';
import { randomUUID } from 'node:crypto';
import { CONFIG } from '../config';
import { allowOrderCreate } from '../lib/rate';
import { getOrSetIdempotency } from '../lib/idempotency';

const CreateOrderSchema = {
  type: 'object',
  required: ['orderType', 'tokenIn', 'tokenOut', 'amount'],
  properties: {
    orderType: { type: 'string', enum: ['market'] },
    tokenIn: { type: 'string', example: 'SOL' },
    tokenOut: { type: 'string', example: 'USDC' },
    amount: { type: 'number', example: 1.25, minimum: 0.0000001 },
    slippageBps: { type: 'integer', minimum: 1, maximum: 10000, example: 50 },
  },
  additionalProperties: false,
} as const;

const CreateOrderResponse = {
  200: {
    description: 'Order accepted',
    type: 'object',
    properties: {
      orderId: { type: 'string', example: 'cuid_or_uuid' },
      idempotent: { type: 'boolean', example: false },
    },
  },
  400: {
    description: 'Invalid body',
    type: 'object',
    properties: {
      error: { type: 'string', example: 'invalid_body' },
      details: { type: 'array' },
    },
  },
  429: {
    description: 'Rate limited',
    type: 'object',
    properties: {
      error: { type: 'string', example: 'rate_limited' },
      message: { type: 'string' },
      currentCount: { type: 'number' },
    },
  },
} as const;

const bodySchema = z.object({
  orderType: z.literal('market'),
  tokenIn: z.string().min(1),
  tokenOut: z.string().min(1),
  amount: z.number().positive(),
  slippageBps: z.number().int().min(1).max(10_000).optional(),
});

export async function registerRoutes(app: FastifyInstance) {
  // WebSocket endpoint on same path (GET)
  app.get('/api/orders/execute', { websocket: true }, (conn, req) => {
    handleOrderWebSocket(conn, req);
  });

  // HTTP submit endpoint (POST)
  app.post(
    '/api/orders/execute',
    {
      schema: {
        tags: ['orders'],
        summary: 'Create & execute a market order',
        description: 'Submit a market order. Use WebSocket GET /api/orders/execute?orderId=... to stream status.',
        body: CreateOrderSchema,
        response: CreateOrderResponse,
      },
    },
    async (req, reply) => {
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.issues });
      }
      const body = parsed.data;
    const gate = await allowOrderCreate();
    if (!gate.allowed) {
      return reply
        .code(429)
        .send({ error: 'rate_limited', message: `API limit ${gate.limit}/min exceeded`, currentCount: gate.count });
    }
    const slippageBps = body.slippageBps ?? CONFIG.DEFAULT_SLIPPAGE_BPS;
    const idemKey = String(req.headers['x-idempotency-key'] || '');
    if (idemKey) {
      const existing = await getOrSetIdempotency(idemKey);
      if (existing) {
        // Re-emit pending so the client WS still sees something if they reconnect
        await publishOrderEvent({ orderId: existing, status: 'pending' });
        return reply.code(200).send({ orderId: existing, idempotent: true });
      }
    }

    // create order row
    const orderId = randomUUID();
    await prisma.order.create({
      data: {
        id: orderId,
        type: body.orderType,
        tokenIn: body.tokenIn,
        tokenOut: body.tokenOut,
        amount: body.amount,
        slippageBps,
        status: 'pending',
      },
    });
    if (idemKey) {
      await getOrSetIdempotency(idemKey, orderId);
    }

    // enqueue job for worker
    await ordersQueue.add('execute', {
      orderId,
      tokenIn: body.tokenIn,
      tokenOut: body.tokenOut,
      amount: body.amount,
      slippageBps,
      orderType: body.orderType,
    });

    // emit first event
    await publishOrderEvent({ orderId, status: 'pending' });

    // Persist the event row (nice to have)
    await prisma.orderEvent.create({
      data: {
        orderId,
        status: 'pending',
        payload: { source: 'api' },
      },
    });

    // return orderId to client
    return reply.code(200).send({ orderId });
    }
  );
}
