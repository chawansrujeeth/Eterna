"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerRoutes = registerRoutes;
const zod_1 = require("zod");
const db_1 = require("../lib/db");
const queue_1 = require("../lib/queue");
const pubsub_1 = require("../lib/pubsub");
const ws_1 = require("./ws");
const node_crypto_1 = require("node:crypto");
const config_1 = require("../config");
const rate_1 = require("../lib/rate");
const idempotency_1 = require("../lib/idempotency");
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
};
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
};
const bodySchema = zod_1.z.object({
    orderType: zod_1.z.literal('market'),
    tokenIn: zod_1.z.string().min(1),
    tokenOut: zod_1.z.string().min(1),
    amount: zod_1.z.number().positive(),
    slippageBps: zod_1.z.number().int().min(1).max(10000).optional(),
});
async function registerRoutes(app) {
    // WebSocket endpoint on same path (GET)
    app.get('/api/orders/execute', { websocket: true }, (conn, req) => {
        (0, ws_1.handleOrderWebSocket)(conn, req);
    });
    // HTTP submit endpoint (POST)
    app.post('/api/orders/execute', {
        schema: {
            tags: ['orders'],
            summary: 'Create & execute a market order',
            description: 'Submit a market order. Use WebSocket GET /api/orders/execute?orderId=... to stream status.',
            body: CreateOrderSchema,
            response: CreateOrderResponse,
        },
    }, async (req, reply) => {
        const parsed = bodySchema.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'invalid_body', details: parsed.error.issues });
        }
        const body = parsed.data;
        const gate = await (0, rate_1.allowOrderCreate)();
        if (!gate.allowed) {
            return reply
                .code(429)
                .send({ error: 'rate_limited', message: `API limit ${gate.limit}/min exceeded`, currentCount: gate.count });
        }
        const slippageBps = body.slippageBps ?? config_1.CONFIG.DEFAULT_SLIPPAGE_BPS;
        const idemKey = String(req.headers['x-idempotency-key'] || '');
        if (idemKey) {
            const existing = await (0, idempotency_1.getOrSetIdempotency)(idemKey);
            if (existing) {
                // Re-emit pending so the client WS still sees something if they reconnect
                await (0, pubsub_1.publishOrderEvent)({ orderId: existing, status: 'pending' });
                return reply.code(200).send({ orderId: existing, idempotent: true });
            }
        }
        // create order row
        const orderId = (0, node_crypto_1.randomUUID)();
        await db_1.prisma.order.create({
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
            await (0, idempotency_1.getOrSetIdempotency)(idemKey, orderId);
        }
        // enqueue job for worker
        await queue_1.ordersQueue.add('execute', {
            orderId,
            tokenIn: body.tokenIn,
            tokenOut: body.tokenOut,
            amount: body.amount,
            slippageBps,
            orderType: body.orderType,
        });
        // emit first event
        await (0, pubsub_1.publishOrderEvent)({ orderId, status: 'pending' });
        // Persist the event row (nice to have)
        await db_1.prisma.orderEvent.create({
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
