import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import { registerRoutes } from './routes';

export async function createApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    ajv: {
      customOptions: {
        // Allow non-JSONSchema keywords (e.g. OpenAPI's "example")
        strict: false
      }
    }
  });

  await app.register(cors, { origin: true });

  await app.register(swagger, {
    openapi: {
      info: { title: 'Order Execution Engine', version: '0.1.0' },
      servers: [{ url: 'http://localhost:3000' }],
      tags: [{ name: 'orders' }]
    }
  });

  await app.register(swaggerUI, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true }
  });

  await app.register(websocket);

  app.get('/health', async () => ({ ok: true }));
  await registerRoutes(app);

  return app;
}
