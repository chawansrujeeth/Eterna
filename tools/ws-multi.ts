import WebSocket from 'ws';

const base = (process.env.WS_BASE || 'ws://localhost:3000') + '/api/orders/execute';
const ids = process.argv.slice(2);

if (!ids.length) {
  console.error('Usage: npm run ws:multi -- <id1> <id2> ...');
  process.exit(1);
}

ids.forEach((id) => {
  const ws = new WebSocket(`${base}?orderId=${encodeURIComponent(id)}`);
  const tag = id.slice(0, 6);

  ws.on('open', () => console.log(`[${tag}] ws_connected`));
  ws.on('message', (data) => {
    try {
      const evt = JSON.parse(String(data));
      const mode = evt.replay ? 'replay' : 'live  ';
      const status = (evt.status ?? '').toString().padEnd(9, ' ');
      const dexInfo = evt.route?.dex ? `dex=${evt.route.dex}` : '';
      const txInfo = evt.txHash ? `tx=${evt.txHash}` : '';
      const extras = [dexInfo, txInfo].filter(Boolean).join(' ');
      console.log(`[${tag}] ${mode} ${status} ${extras}`.trim());
    } catch {
      console.log(`[${tag}] ${String(data)}`);
    }
  });
  ws.on('close', () => console.log(`[${tag}] closed`));
  ws.on('error', (err) => console.error(`[${tag}] error`, err.message));
});
