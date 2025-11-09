"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockDexRouter = exports.sleep = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
exports.sleep = sleep;
function basePriceForPair(tokenIn, tokenOut) {
    const pair = `${tokenIn}/${tokenOut}`.toUpperCase();
    if (pair === 'SOL/USDC')
        return 150;
    if (pair === 'BTC/USDC')
        return 60000;
    return 100; // default baseline
}
class MockDexRouter {
    async getRaydiumQuote(tokenIn, tokenOut, amount) {
        await (0, exports.sleep)(200 + Math.random() * 150);
        const base = basePriceForPair(tokenIn, tokenOut);
        const price = base * (0.98 + Math.random() * 0.04); // 98% - 102%
        return { dex: 'Raydium', price, fee: 0.003 };
    }
    async getMeteoraQuote(tokenIn, tokenOut, amount) {
        await (0, exports.sleep)(200 + Math.random() * 150);
        const base = basePriceForPair(tokenIn, tokenOut);
        const price = base * (0.97 + Math.random() * 0.05); // 97% - 102%
        return { dex: 'Meteora', price, fee: 0.002 };
    }
    pickBest(amountIn, q1, q2) {
        const out1 = amountIn * q1.price * (1 - q1.fee);
        const out2 = amountIn * q2.price * (1 - q2.fee);
        return out1 >= out2 ? { best: q1, amountOut: out1 } : { best: q2, amountOut: out2 };
    }
    generateMockTxHash() {
        return '0x' + node_crypto_1.default.randomBytes(16).toString('hex');
    }
    async simulateExecution(quotePrice) {
        // Simulate 2–3s on-chain time with small price drift (±0.3%)
        await (0, exports.sleep)(2000 + Math.random() * 1000);
        const driftFactor = 1 + (Math.random() * 0.006 - 0.003);
        return { executedPrice: quotePrice * driftFactor };
    }
}
exports.MockDexRouter = MockDexRouter;
