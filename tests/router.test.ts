import { MockDexRouter } from '../src/dex/MockDexRouter';

test('pick best quote considering fees', async () => {
  const r = new MockDexRouter();
  const amount = 2;

  const ray = { dex: 'Raydium', price: 100, fee: 0.003 } as any;
  const met = { dex: 'Meteora', price: 100, fee: 0.010 } as any; // same price, worse fee
  const out1 = amount * ray.price * (1 - ray.fee);
  const out2 = amount * met.price * (1 - met.fee);
  expect(out1 > out2).toBe(true);
  const { best } = r.pickBest(amount, ray, met);
  expect(best).toBe(ray);
});
