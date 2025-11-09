"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = require("../lib/db");
(async () => {
    const count = await db_1.prisma.order.count();
    console.log('Order rows:', count);
    process.exit(0);
})();
