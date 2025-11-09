import fetch from 'node-fetch';

type OrderBody = {
  orderType: 'market';
  tokenIn: string;
  tokenOut: string;
  amount: number;
  slippageBps: number;
};

type OrderResponse = {
  orderId?: string;
  idempotent?: boolean;
  error?: string;
  [key: string]: any;
};

const base = process.env.BASE_URL || 'http://localhost:3000';
const n = Math.max(1, Number(process.argv[2] || 5));

const buildBody = (slippageBps: number): OrderBody => ({
  orderType: 'market',
  tokenIn: 'SOL',
  tokenOut: 'USDC',
  amount: 1.0,
  slippageBps,
});

async function submitOrder(slippageBps: number): Promise<OrderResponse> {
  try {
    const resp = await fetch(`${base}/api/orders/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(slippageBps)),
    });

    const text = await resp.text();
    let data: OrderResponse = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!resp.ok) {
      return { error: `HTTP_${resp.status}`, detail: data };
    }

    return data;
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'UNKNOWN_ERROR' };
  }
}

(async () => {
  const requests = Array.from({ length: n }, (_, i) => submitOrder(i === 0 ? 5 : 50));
  const responses = await Promise.all(requests);
  const ids = responses.map((r) => r?.orderId || 'ERR');
  console.log('orderIds:', ids.join(' '));
  console.log(JSON.stringify(responses, null, 2));
})();
