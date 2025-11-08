import type { FastifyRequest } from 'fastify';
import type { SocketStream } from '@fastify/websocket';
import type WebSocket from 'ws';
import { subscribeOrderEvents } from '../lib/pubsub';
import { logger } from '../lib/logger';
import { prisma } from '../lib/db';

type MaybeSocketStream = SocketStream & { socket?: WebSocket };

const getSocket = (connection: MaybeSocketStream): WebSocket => {
  if (connection.socket) {
    return connection.socket;
  }
  return connection as unknown as WebSocket;
};

export async function handleOrderWebSocket(connection: SocketStream, req: FastifyRequest) {
  const ws = getSocket(connection as MaybeSocketStream);
  const url = new URL(req.url, 'http://localhost'); // base ignored
  const orderId = url.searchParams.get('orderId');
  if (!orderId) {
    ws.send(JSON.stringify({ error: 'orderId query param required' }));
    ws.close();
    return;
  }

  const sendSafe = (payload: unknown) => {
    try {
      ws.send(JSON.stringify(payload));
    } catch (e) {
      logger.error({ e }, 'WS send failed');
    }
  };

  sendSafe({ orderId, status: 'ws_connected', ts: Date.now() });

  const history = await prisma.orderEvent.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
  });
  for (const evt of history) {
    sendSafe({
      orderId: evt.orderId,
      status: evt.status,
      payload: evt.payload ?? undefined,
      ts: evt.createdAt.getTime(),
      replay: true,
    });
  }

  const unsubscribe = await subscribeOrderEvents(orderId, (evt) => {
    sendSafe(evt);
  });

  ws.on('close', async () => {
    try {
      await unsubscribe();
    } catch {
      /* ignore */
    }
  });

  // ws_connected already sent before history replay
}
