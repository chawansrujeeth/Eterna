export const CONFIG = {
  DEFAULT_SLIPPAGE_BPS: Number(process.env.DEFAULT_SLIPPAGE_BPS ?? 50), // 0.5%
  API_MAX_ORDERS_PER_MIN: Number(process.env.API_MAX_ORDERS_PER_MIN ?? 120),
  QUEUE_MAX_PER_MIN: Number(process.env.QUEUE_MAX_PER_MIN ?? 100),
};
