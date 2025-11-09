ARG PRISMA_GENERATE_DB_URL="postgresql://postgres:postgres@localhost:5432/postgres"

# ---------- builder ----------
FROM node:20-alpine AS builder
ARG PRISMA_GENERATE_DB_URL
WORKDIR /app

# system deps (optional but handy)
RUN apk add --no-cache python3 make g++

COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN DATABASE_URL="$PRISMA_GENERATE_DB_URL" npm ci

# Prisma generate needs schema present
RUN DATABASE_URL="$PRISMA_GENERATE_DB_URL" npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- runner ----------
FROM node:20-alpine AS runner
ARG PRISMA_GENERATE_DB_URL
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Install only prod deps
COPY package*.json ./
# Prisma schema/config needed for postinstall generate step
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN DATABASE_URL="$PRISMA_GENERATE_DB_URL" npm ci --omit=dev

# copy prisma client artifacts
COPY --from=builder /app/node_modules/.prisma /app/node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma /app/node_modules/@prisma

# app dist + prisma schema + start scripts
COPY --from=builder /app/dist /app/dist
COPY start-api.sh start-worker.sh ./

# healthcheck for platforms that use it
RUN apk add --no-cache curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/health || exit 1

EXPOSE 3000

# Default to API; override command for worker
CMD ["sh", "./start-api.sh"]
