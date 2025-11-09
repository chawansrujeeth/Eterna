"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOrSetIdempotency = getOrSetIdempotency;
const ioredis_1 = __importDefault(require("ioredis"));
const r = new ioredis_1.default(process.env.REDIS_URL || 'redis://localhost:6379');
async function getOrSetIdempotency(key, orderId, ttlSec = 3600) {
    const existing = await r.get(`idem:${key}`);
    if (existing)
        return existing;
    if (orderId) {
        const ok = await r.set(`idem:${key}`, orderId, 'EX', ttlSec, 'NX');
        if (ok !== 'OK')
            return (await r.get(`idem:${key}`));
        return orderId;
    }
    return null;
}
