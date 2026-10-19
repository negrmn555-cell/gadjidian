# ---- build ----
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/app/package.json packages/app/
RUN npm install --global npm@11.17.0 && npm ci --ignore-scripts
COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts

# ---- runtime ----
FROM node:22-alpine
ARG APP_REVISION=unknown
LABEL org.opencontainers.image.revision=$APP_REVISION
RUN apk add --no-cache git openssh-client tini
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages/core/package.json ./packages/core/
COPY --from=build /src/packages/core/dist ./packages/core/dist
COPY --from=build /src/packages/server/package.json ./packages/server/
COPY --from=build /src/packages/server/dist ./packages/server/dist
COPY --from=build /src/packages/app/dist ./packages/app/dist
RUN mkdir -p /data && chown -R node:node /data /app
USER node
ENV DATA_DIR=/data VAULT_PATH=/data/vault STATIC_DIR=/app/packages/app/dist PORT=8080 HOST=0.0.0.0
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/server/dist/index.js"]
