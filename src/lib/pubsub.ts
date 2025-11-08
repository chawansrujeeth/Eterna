import IORedis from 'ioredis';

const url = process.env.REDIS_URL || 'redis://localhost:6379';

// Dedicated connections for pub/sub
const publisher = new IORedis(url);
const subscriber = new IORedis(url);

export type PubSubOrderEvent = {
  orderId: string;
  status: string;
  ts?: number;
  [k: string]: any;
};

const channelFor = (orderId: string) => `order:events:${orderId}`;

export async function publishOrderEvent(evt: PubSubOrderEvent) {
  if (!evt?.orderId) throw new Error('publishOrderEvent: missing orderId');
  await publisher.publish(
    channelFor(evt.orderId),
    JSON.stringify({ ...evt, ts: evt.ts ?? Date.now() }),
  );
}

export async function subscribeOrderEvents(
  orderId: string,
  onEvent: (e: PubSubOrderEvent) => void,
) {
  const channel = channelFor(orderId);
  const handler = (ch: string, msg: string) => {
    if (ch !== channel) return;
    try {
      onEvent(JSON.parse(msg));
    } catch {
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
