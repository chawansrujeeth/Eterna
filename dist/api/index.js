"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = require("./app");
const logger_1 = require("../lib/logger");
const port = Number(process.env.PORT || 3000);
const host = '0.0.0.0';
(async () => {
    try {
        const app = await (0, app_1.createApp)();
        await app.listen({ port, host });
        logger_1.logger.info(`API up on :${port}`);
    }
    catch (err) {
        logger_1.logger.error({ err }, 'API boot failed');
        process.exit(1);
    }
})();
