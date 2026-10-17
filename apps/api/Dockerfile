# syntax=docker/dockerfile:1
# Production API image — secrets must be injected at runtime, never baked in.

FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace=@ai-company/api --include-workspace-root

FROM deps AS build
COPY apps/api apps/api
WORKDIR /app/apps/api
# Generate client without a live database (prisma.config allows empty DATABASE_URL).
ENV DATABASE_URL=
RUN npx prisma generate && npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache libc6-compat openssl curl \
  && addgroup -S hq && adduser -S hq -G hq

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace=@ai-company/api --include-workspace-root --omit=dev \
  && npm cache clean --force

COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/prisma apps/api/prisma
COPY --from=build /app/apps/api/prisma.config.ts apps/api/prisma.config.ts
COPY --from=build /app/apps/api/src/generated apps/api/src/generated
COPY apps/api/docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && chown -R hq:hq /app

USER hq
WORKDIR /app/apps/api
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/api/health/live || exit 1
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/main.js"]
