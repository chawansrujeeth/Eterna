#!/bin/sh
set -e
echo "[start-worker] running prisma migrate deploy..."
npx prisma migrate deploy
echo "[start-worker] starting Worker..."
exec node dist/worker/index.js
