#!/bin/sh
set -e
echo "[start-api] running prisma migrate deploy..."
npx prisma migrate deploy
echo "[start-api] starting API..."
exec node dist/api/index.js
