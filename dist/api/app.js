"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
const fastify_1 = __importDefault(require("fastify"));
const cors_1 = __importDefault(require("@fastify/cors"));
const swagger_1 = __importDefault(require("@fastify/swagger"));
const swagger_ui_1 = __importDefault(require("@fastify/swagger-ui"));
const websocket_1 = __importDefault(require("@fastify/websocket"));
const routes_1 = require("./routes");
async function createApp() {
    const app = (0, fastify_1.default)({
        logger: false,
        ajv: {
            customOptions: {
                // Allow non-JSONSchema keywords (e.g. OpenAPI's "example")
                strict: false
            }
        }
    });
    await app.register(cors_1.default, { origin: true });
    await app.register(swagger_1.default, {
        openapi: {
            info: { title: 'Order Execution Engine', version: '0.1.0' },
            servers: [{ url: 'http://localhost:3000' }],
            tags: [{ name: 'orders' }]
        }
    });
    await app.register(swagger_ui_1.default, {
        routePrefix: '/docs',
        uiConfig: { docExpansion: 'list', deepLinking: true }
    });
    await app.register(websocket_1.default);
    app.get('/health', async () => ({ ok: true }));
    await (0, routes_1.registerRoutes)(app);
    return app;
}
