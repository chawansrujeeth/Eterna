import IORedis from 'ioredis';
const r = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379');

export async function getOrSetIdempotency(key: string, orderId?: string, ttlSec = 3600) {
  const existing = await r.get(`idem:${key}`);
  if (existing) return existing;
  if (orderId) {
    const ok = await r.set(`idem:${key}`, orderId, 'EX', ttlSec, 'NX');
    if (ok !== 'OK') return (await r.get(`idem:${key}`))!;
    return orderId;
  }
  return null;
}
