# Builds either the API or the worker image:
#   docker build --build-arg APP=api    -t assessiq-api .
#   docker build --build-arg APP=worker -t assessiq-worker .
FROM node:22-alpine AS build
ARG APP
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/${APP}/package.json apps/${APP}/
RUN npm ci -w @assessiq/shared -w @assessiq/${APP} --include-workspace-root=false

COPY packages/shared packages/shared
COPY apps/${APP} apps/${APP}
RUN npm run build -w @assessiq/shared -w @assessiq/${APP}
# Drop dev dependencies for the runtime image.
RUN npm prune --omit=dev -w @assessiq/shared -w @assessiq/${APP}

FROM node:22-alpine AS runtime
ARG APP
ENV NODE_ENV=production APP=${APP}
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/${APP} ./apps/${APP}
COPY package.json ./
USER node
WORKDIR /app/apps/${APP}
CMD ["node", "dist/main.js"]
