# Build context is the repo root (see ../../docker-compose.yml) because this is an
# npm workspace — `npm ci` needs the root lockfile plus every workspace's package.json.
FROM node:22-alpine AS build
WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/storefront-brand-a/package.json apps/storefront-brand-a/package.json
COPY apps/storefront-brand-b/package.json apps/storefront-brand-b/package.json
RUN npm ci

COPY apps/backend apps/backend
RUN npm run build --workspace=@dtc/backend

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/apps/backend ./apps/backend

WORKDIR /repo/apps/backend
EXPOSE 9000
CMD ["npm", "run", "start"]
