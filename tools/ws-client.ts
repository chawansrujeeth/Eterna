import WebSocket from 'ws';

const base = process.env.BASE_URL || 'ws://localhost:3000';
const orderId = process.argv[2];
if (!orderId) {
  console.error('Usage: node tools/ws-client.js <orderId>');
  process.exit(1);
}

const url = `${base}/api/orders/execute?orderId=${orderId}`;
const ws = new WebSocket(url);

ws.on('open', () => console.log('WS connected:', url));
ws.on('message', (data) => {
  try {
    console.log('EVENT:', JSON.parse(String(data)));
  } catch {
    console.log('RAW:', String(data));
  }
});
ws.on('close', () => console.log('WS closed'));
ws.on('error', (e) => console.error('WS error', e));
