import crypto from 'node:crypto';

export type Quote = {
  dex: 'Raydium' | 'Meteora';
  price: number; // quoted price for tokenIn->tokenOut (amountOut = amountIn * price * (1-fee))
  fee: number; // e.g., 0.003 = 0.3%
};

export const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

function basePriceForPair(tokenIn: string, tokenOut: string): number {
  const pair = `${tokenIn}/${tokenOut}`.toUpperCase();
  if (pair === 'SOL/USDC') return 150;
  if (pair === 'BTC/USDC') return 60000;
  return 100; // default baseline
}

export class MockDexRouter {
  async getRaydiumQuote(tokenIn: string, tokenOut: string, amount: number): Promise<Quote> {
    await sleep(200 + Math.random() * 150);
    const base = basePriceForPair(tokenIn, tokenOut);
    const price = base * (0.98 + Math.random() * 0.04); // 98% - 102%
    return { dex: 'Raydium', price, fee: 0.003 };
  }

  async getMeteoraQuote(tokenIn: string, tokenOut: string, amount: number): Promise<Quote> {
    await sleep(200 + Math.random() * 150);
    const base = basePriceForPair(tokenIn, tokenOut);
    const price = base * (0.97 + Math.random() * 0.05); // 97% - 102%
    return { dex: 'Meteora', price, fee: 0.002 };
  }

  pickBest(amountIn: number, q1: Quote, q2: Quote) {
    const out1 = amountIn * q1.price * (1 - q1.fee);
    const out2 = amountIn * q2.price * (1 - q2.fee);
    return out1 >= out2 ? { best: q1, amountOut: out1 } : { best: q2, amountOut: out2 };
  }

  generateMockTxHash(): string {
    return '0x' + crypto.randomBytes(16).toString('hex');
  }

  async simulateExecution(quotePrice: number): Promise<{ executedPrice: number }> {
    // Simulate 2–3s on-chain time with small price drift (±0.3%)
    await sleep(2000 + Math.random() * 1000);
    const driftFactor = 1 + (Math.random() * 0.006 - 0.003);
    return { executedPrice: quotePrice * driftFactor };
  }
}
