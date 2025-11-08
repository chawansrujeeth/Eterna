import { createApp } from './app';
import { logger } from '../lib/logger';

const port = Number(process.env.PORT || 3000);
const host = '0.0.0.0';

(async () => {
  try {
    const app = await createApp();
    await app.listen({ port, host });
    logger.info(`API up on :${port}`);
  } catch (err) {
    logger.error({ err }, 'API boot failed');
    process.exit(1);
  }
})();
