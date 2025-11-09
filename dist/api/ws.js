"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleOrderWebSocket = handleOrderWebSocket;
const pubsub_1 = require("../lib/pubsub");
const logger_1 = require("../lib/logger");
const db_1 = require("../lib/db");
const isSocketStream = (connection) => typeof connection.socket !== 'undefined';
const getSocket = (connection) => {
    if (isSocketStream(connection)) {
        return connection.socket;
    }
    return connection;
};
async function handleOrderWebSocket(connection, req) {
    const ws = getSocket(connection);
    const url = new URL(req.url, 'http://localhost'); // base ignored
    const orderId = url.searchParams.get('orderId');
    if (!orderId) {
        ws.send(JSON.stringify({ error: 'orderId query param required' }));
        ws.close();
        return;
    }
    const sendSafe = (payload) => {
        try {
            ws.send(JSON.stringify(payload));
        }
        catch (e) {
            logger_1.logger.error({ e }, 'WS send failed');
        }
    };
    sendSafe({ orderId, status: 'ws_connected', ts: Date.now() });
    const history = await db_1.prisma.orderEvent.findMany({
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
    const unsubscribe = await (0, pubsub_1.subscribeOrderEvents)(orderId, (evt) => {
        sendSafe(evt);
    });
    ws.on('close', async () => {
        try {
            await unsubscribe();
        }
        catch {
            /* ignore */
        }
    });
    // ws_connected already sent before history replay
}
