"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ordersQueue = void 0;
exports.shutdownOrdersQueue = shutdownOrdersQueue;
const bullmq_1 = require("bullmq");
const ioredis_1 = __importDefault(require("ioredis"));
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const ordersQueueConnection = new ioredis_1.default(redisUrl, {
    maxRetriesPerRequest: null, // required by BullMQ for blocking connections
});
exports.ordersQueue = new bullmq_1.Queue('orders', {
    connection: ordersQueueConnection,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 500 },
        removeOnComplete: true,
        removeOnFail: false,
    },
});
let queueClosed = false;
async function shutdownOrdersQueue() {
    if (queueClosed)
        return;
    queueClosed = true;
    try {
        await exports.ordersQueue.close();
    }
    catch {
        // ignore close errors so shutdown path is always attempted
    }
    if (typeof ordersQueueConnection.quit === 'function') {
        try {
            await ordersQueueConnection.quit();
        }
        catch {
            // ignore quit errors during shutdown
        }
    }
}
