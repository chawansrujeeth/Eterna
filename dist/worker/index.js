"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createHandler = createHandler;
exports.startWorker = startWorker;
const bullmq_1 = require("bullmq");
const ioredis_1 = __importDefault(require("ioredis"));
const logger_1 = require("../lib/logger");
const db_1 = require("../lib/db");
const pubsub_1 = require("../lib/pubsub");
const MockDexRouter_1 = require("../dex/MockDexRouter");
const math_1 = require("../lib/math");
const defaultConnection = () => new ioredis_1.default(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
});
function createHandler(router = new MockDexRouter_1.MockDexRouter()) {
    return async function handleJob(job) {
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
        await db_1.prisma.order.update({ where: { id: orderId }, data: { routeDex: best.dex } });
        // 1.5) Mock wrapped SOL branch (no-op but testable)
        const needsWrap = tokenIn.toUpperCase() === 'SOL' && tokenOut.toUpperCase() !== 'SOL';
        if (needsWrap) {
            await (0, pubsub_1.publishOrderEvent)({ orderId, status: 'pending', detail: { wrappedSol: true }, ts: Date.now() });
        }
        // 2) BUILDING
        await setStatus(orderId, 'building', { route: { dex: best.dex, expectedPrice: best.price, fee: best.fee } });
        await (0, MockDexRouter_1.sleep)(150);
        // 3) SUBMITTED
        const txHash = router.generateMockTxHash();
        await setStatus(orderId, 'submitted', { txHash });
        // 4) EXECUTION
        const { executedPrice } = await router.simulateExecution(best.price);
        const usedBps = Math.round((0, math_1.bpsDelta)(executedPrice, best.price));
        if (usedBps > slippageBps) {
            const reason = `SLIPPAGE_EXCEEDED: used ${usedBps} bps > allowed ${slippageBps} bps`;
            await db_1.prisma.order.update({ where: { id: orderId }, data: { failureReason: reason } });
            await (0, pubsub_1.publishOrderEvent)({ orderId, status: 'failed', error: reason, ts: Date.now(), lastStep: 'submitted' });
            await db_1.prisma.orderEvent.create({ data: { orderId, status: 'failed', payload: { error: reason, lastStep: 'submitted' } } });
            throw new Error(reason);
        }
        const amountOutFinal = amount * executedPrice * (1 - best.fee);
        await db_1.prisma.order.update({ where: { id: orderId }, data: { executedPrice, amountOut: amountOutFinal, txHash } });
        await (0, pubsub_1.publishOrderEvent)({
            orderId,
            status: 'confirmed',
            txHash,
            execution: { executedPrice, amountIn: amount, amountOut: amountOutFinal, slippageBpsUsed: usedBps },
            route: { dex: best.dex, expectedPrice: best.price, fee: best.fee },
            ts: Date.now(),
        });
        await db_1.prisma.orderEvent.create({
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
async function setStatus(orderId, status, payload = {}) {
    await (0, pubsub_1.publishOrderEvent)({ orderId, status, ts: Date.now(), ...payload });
    await db_1.prisma.orderEvent.create({ data: { orderId, status, payload } });
    await db_1.prisma.order.update({ where: { id: orderId }, data: { status } });
}
function startWorker(opts) {
    const connection = opts?.connection ?? defaultConnection();
    const handler = opts?.handler ?? createHandler();
    const worker = new bullmq_1.Worker('orders', handler, {
        connection,
        concurrency: opts?.concurrency ?? 10,
    });
    worker.on('failed', async (job, err) => {
        if (!job)
            return;
        const orderId = job.data.orderId;
        const ord = await db_1.prisma.order.findUnique({ where: { id: orderId } });
        if (ord && ord.status !== 'confirmed') {
            const reason = err?.message || 'UNKNOWN_ERROR';
            await db_1.prisma.order.update({ where: { id: orderId }, data: { status: 'failed', failureReason: reason } });
            await (0, pubsub_1.publishOrderEvent)({ orderId, status: 'failed', error: reason, ts: Date.now(), lastStep: ord?.status });
            await db_1.prisma.orderEvent.create({ data: { orderId, status: 'failed', payload: { error: reason, lastStep: ord?.status } } });
        }
    });
    return worker;
}
// Dev-only entrypoint
if (process.env.NODE_ENV !== 'test' && require.main === module) {
    startWorker();
    logger_1.logger.info('Worker up (testable entry)');
    console.log('Worker up (testable entry)');
}
