import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import { logger } from '../lib/logger';

const app = Fastify({ logger: true });

const start = async () => {
  await app.register(cors, { origin: true });
  await app.register(swagger, {
    openapi: { info: { title: 'Order Engine', version: '0.1.0' } },
  });

  app.get('/health', async () => ({ ok: true }));

  const port = Number(process.env.PORT || 3000);
  await app.listen({ port, host: '0.0.0.0' });
  logger.info(`API up on :${port}`);
};

start().catch((err) => {
  app.log.error(err, 'Failed to start Fastify app');
  process.exit(1);
});
