import type { FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import { orderBus } from '../lib/bus';
import { logger } from '../lib/logger';

type SocketLike = WebSocket & { socket?: WebSocket };

const getSocket = (connection: SocketLike): WebSocket => {
  if (connection.socket) {
    return connection.socket;
  }
  return connection;
};

export function handleOrderWebSocket(connection: SocketLike, req: FastifyRequest) {
  const ws = getSocket(connection);
  const url = new URL(req.url, 'http://localhost'); // base ignored
  const orderId = url.searchParams.get('orderId');

  const safeSend = (payload: unknown, context: string) => {
    if (ws.readyState !== ws.OPEN) {
      logger.warn({ orderId, context, readyState: ws.readyState }, 'WS not open, skipping send');
      return;
    }
    try {
      ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          logger.error({ err, orderId, context }, 'WS send failed');
        }
      });
    } catch (err) {
      logger.error({ err, orderId, context }, 'WS send threw');
    }
  };

  if (!orderId) {
    safeSend({ error: 'orderId query param required' }, 'missing_order_id');
    ws.close();
    return;
  }

  const unsubscribe = orderBus.subscribe(orderId, (evt) => {
    safeSend(evt, 'order_event');
  });

  ws.on('close', () => {
    unsubscribe();
  });

  ws.on('error', (err) => {
    logger.error({ err, orderId }, 'WS socket error');
  });

  const sendAck = () => {
    logger.info({ orderId }, 'WS order stream connected');
    safeSend({ orderId, status: 'ws_connected', ts: Date.now() }, 'ws_connected');
  };

  if (ws.readyState === ws.OPEN) {
    queueMicrotask(sendAck);
  } else {
    ws.once('open', sendAck);
  }
}
