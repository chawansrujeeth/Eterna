"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.allowOrderCreate = allowOrderCreate;
const ioredis_1 = __importDefault(require("ioredis"));
const config_1 = require("../config");
const r = new ioredis_1.default(process.env.REDIS_URL || 'redis://localhost:6379');
function minuteKey(prefix) {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mm = String(now.getUTCMinutes()).padStart(2, '0');
    return `${prefix}:${y}${m}${d}${hh}${mm}`;
}
async function allowOrderCreate() {
    const key = minuteKey('rate:orders');
    const count = await r.incr(key);
    if (count === 1) {
        await r.expire(key, 65);
    }
    const limit = config_1.CONFIG.API_MAX_ORDERS_PER_MIN;
    return { allowed: count <= limit, count, limit };
}
