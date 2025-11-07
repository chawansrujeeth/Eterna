import { prisma } from '../lib/db';

(async () => {
  const count = await prisma.order.count();
  console.log('Order rows:', count);
  process.exit(0);
})();
