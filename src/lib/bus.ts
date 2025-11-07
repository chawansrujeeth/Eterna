import { EventEmitter } from 'node:events';

type OrderEventPayload = {
  orderId: string;
  status: string;
  ts?: number;
  [k: string]: any;
};

class OrderBus {
  private channels = new Map<string, EventEmitter>();

  get(orderId: string) {
    if (!this.channels.has(orderId)) {
      this.channels.set(orderId, new EventEmitter());
    }
    return this.channels.get(orderId)!;
  }

  publish(orderId: string, event: OrderEventPayload) {
    const ch = this.get(orderId);
    ch.emit('event', event);
  }

  subscribe(orderId: string, listener: (e: OrderEventPayload) => void) {
    const ch = this.get(orderId);
    ch.on('event', listener);
    return () => ch.off('event', listener);
  }
}

export const orderBus = new OrderBus();
