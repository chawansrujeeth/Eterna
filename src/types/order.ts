export type OrderType = 'market';
export type OrderStatus = 'pending' | 'routing' | 'building' | 'submitted' | 'confirmed' | 'failed';

export interface CreateOrderBody {
  orderType: OrderType;
  tokenIn: string;
  tokenOut: string;
  amount: number;
  slippageBps?: number;
}

export interface OrderEvent {
  orderId: string;
  status: OrderStatus;
  ts: number;
  route?: { dex: 'Raydium' | 'Meteora'; expectedPrice?: number };
  txHash?: string;
  execution?: { executedPrice: number; amountIn: number; amountOut: number; slippageBpsUsed: number };
  error?: string;
  details?: Record<string, unknown>;
}
