FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci
COPY . .
RUN npm run check

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production NFA_BIND_HOST=0.0.0.0 NFA_PORT=3102 NFA_DATA_DIR=/data
EXPOSE 3102
HEALTHCHECK --interval=30s --timeout=7s --start-period=15s CMD node -e "fetch('http://127.0.0.1:3102/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "services/api/server.mjs"]
