"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.publishOrderEvent = publishOrderEvent;
exports.subscribeOrderEvents = subscribeOrderEvents;
const ioredis_1 = __importDefault(require("ioredis"));
const url = process.env.REDIS_URL || 'redis://localhost:6379';
// Dedicated connections for pub/sub
const publisher = new ioredis_1.default(url);
const subscriber = new ioredis_1.default(url);
const channelFor = (orderId) => `order:events:${orderId}`;
async function publishOrderEvent(evt) {
    if (!evt?.orderId)
        throw new Error('publishOrderEvent: missing orderId');
    await publisher.publish(channelFor(evt.orderId), JSON.stringify({ ...evt, ts: evt.ts ?? Date.now() }));
}
async function subscribeOrderEvents(orderId, onEvent) {
    const channel = channelFor(orderId);
    const handler = (ch, msg) => {
        if (ch !== channel)
            return;
        try {
            onEvent(JSON.parse(msg));
        }
        catch {
            /* ignore */
        }
    };
    await subscriber.subscribe(channel);
    subscriber.on('message', handler);
    return async () => {
        subscriber.off('message', handler);
        await subscriber.unsubscribe(channel);
    };
}
