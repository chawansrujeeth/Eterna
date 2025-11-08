import type { FastifyRequest } from 'fastify';
import type { Duplex } from 'node:stream';
import type WebSocket from 'ws';
import { subscribeOrderEvents } from '../lib/pubsub';
import { logger } from '../lib/logger';
import { prisma } from '../lib/db';

type SocketStream = Duplex & { socket: WebSocket };
type MaybeSocketStream = Duplex & { socket?: WebSocket };

const isSocketStream = (connection: MaybeSocketStream | WebSocket): connection is SocketStream =>
  typeof (connection as MaybeSocketStream).socket !== 'undefined';

const getSocket = (connection: MaybeSocketStream | WebSocket): WebSocket => {
  if (isSocketStream(connection)) {
    return connection.socket;
  }
  return connection as unknown as WebSocket;
};

export async function handleOrderWebSocket(connection: MaybeSocketStream | WebSocket, req: FastifyRequest) {
  const ws = getSocket(connection);
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
