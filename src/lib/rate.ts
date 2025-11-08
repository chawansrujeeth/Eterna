import IORedis from 'ioredis';
import { CONFIG } from '../config';

const r = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379');

function minuteKey(prefix: string) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  return `${prefix}:${y}${m}${d}${hh}${mm}`;
}

export async function allowOrderCreate(): Promise<{ allowed: boolean; count: number; limit: number }> {
  const key = minuteKey('rate:orders');
  const count = await r.incr(key);
  if (count === 1) {
    await r.expire(key, 65);
  }
  const limit = CONFIG.API_MAX_ORDERS_PER_MIN;
  return { allowed: count <= limit, count, limit };
}
