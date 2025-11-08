import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db';
import { ordersQueue } from '../lib/queue';
import { publishOrderEvent } from '../lib/pubsub';
import { handleOrderWebSocket } from './ws';
import { randomUUID } from 'node:crypto';
import { CONFIG } from '../config';
import { allowOrderCreate } from '../lib/rate';

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
  app.post('/api/orders/execute', async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.errors });
    }
    const body = parsed.data;
    const gate = await allowOrderCreate();
    if (!gate.allowed) {
      return reply
        .code(429)
        .send({ error: 'rate_limited', message: `API limit ${gate.limit}/min exceeded`, currentCount: gate.count });
    }
    const slippageBps = body.slippageBps ?? CONFIG.DEFAULT_SLIPPAGE_BPS;

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
  });
}
