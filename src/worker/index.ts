import { logger } from '../lib/logger';

logger.info('Worker placeholder started');
setInterval(() => {}, 1 << 30); // keep alive
