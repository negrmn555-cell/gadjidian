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

# A clean production tree avoids expensive copy-up/rename of dev packages in OverlayFS.
FROM node:22-alpine AS production-deps
WORKDIR /src
COPY --from=build /src/package.json /src/package-lock.json ./
COPY --from=build /src/packages/core/package.json packages/core/
COPY --from=build /src/packages/server/package.json packages/server/
COPY --from=build /src/packages/app/package.json packages/app/
RUN --mount=type=cache,id=relay-production-npm,from=build,source=/root/.npm,target=/root/.npm \
    npm install --global npm@11.17.0 --offline --ignore-scripts && npm ci --omit=dev --ignore-scripts --offline

# ---- runtime ----
FROM node:22-alpine
RUN apk add --no-cache git openssh-client tini
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /src/package.json ./
COPY --from=production-deps /src/node_modules ./node_modules
COPY --from=build /src/packages/core/package.json ./packages/core/
COPY --from=build /src/packages/core/dist ./packages/core/dist
COPY --from=build /src/packages/server/package.json ./packages/server/
COPY --from=build /src/packages/server/dist ./packages/server/dist
COPY --from=build /src/packages/app/dist ./packages/app/dist
RUN mkdir -p /data && chown node:node /data
USER node
ENV DATA_DIR=/data VAULT_PATH=/data/vault STATIC_DIR=/app/packages/app/dist PORT=8080 HOST=0.0.0.0
ARG APP_REVISION=unknown
LABEL org.opencontainers.image.revision=$APP_REVISION
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/server/dist/index.js"]
