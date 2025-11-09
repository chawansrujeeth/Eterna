"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.orderBus = void 0;
const node_events_1 = require("node:events");
class OrderBus {
    constructor() {
        this.channels = new Map();
    }
    get(orderId) {
        if (!this.channels.has(orderId)) {
            this.channels.set(orderId, new node_events_1.EventEmitter());
        }
        return this.channels.get(orderId);
    }
    publish(orderId, event) {
        const ch = this.get(orderId);
        ch.emit('event', event);
    }
    subscribe(orderId, listener) {
        const ch = this.get(orderId);
        ch.on('event', listener);
        return () => ch.off('event', listener);
    }
}
exports.orderBus = new OrderBus();
