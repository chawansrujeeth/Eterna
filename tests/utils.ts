import { createApp } from '../src/api/app';
import { startWorker } from '../src/worker/index';
import { prisma } from '../src/lib/db';
import IORedis from 'ioredis';
import WebSocket from 'ws';

export async function resetDb() {
  await prisma.orderEvent.deleteMany({});
  await prisma.order.deleteMany({});
}

export async function flushRedis() {
  const r = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379');
  await r.flushdb();
  await r.quit();
}

export async function startApi() {
  const app = await createApp();
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const url = typeof address === 'string' ? address : `http://127.0.0.1:${(app.server.address() as any).port}`;
  return { app, url };
}

export function startTestWorker() {
  const worker = startWorker({ concurrency: 10 });
  return worker;
}

export async function openWs(base: string, orderId: string) {
  const wsUrl = base.replace('http', 'ws') + `/api/orders/execute?orderId=${orderId}`;
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });
  return ws;
}

export async function collectEvents(ws: WebSocket, untilStatuses: Array<string>, timeoutMs = 15000) {
  const events: any[] = [];
  return await new Promise<any[]>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timeout waiting events')), timeoutMs);
    ws.on('message', (buf) => {
      try {
        const data = JSON.parse(String(buf));
        events.push(data);
        if (untilStatuses.includes(data.status)) {
          clearTimeout(to);
          resolve(events);
        }
      } catch {
        /* ignore */
      }
    });
  });
}
