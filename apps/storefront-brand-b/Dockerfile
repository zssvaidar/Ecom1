# Build context is the repo root (see ../../docker-compose.yml) because this is an
# npm workspace — `npm ci` needs the root lockfile plus every workspace's package.json.
#
# NEXT_PUBLIC_* values are inlined at build time, so they must arrive as build args,
# not just runtime env vars (docker-compose.yml passes them through).
FROM node:22-alpine AS build
WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/storefront-brand-a/package.json apps/storefront-brand-a/package.json
COPY apps/storefront-brand-b/package.json apps/storefront-brand-b/package.json
RUN npm ci

COPY apps/storefront-brand-b apps/storefront-brand-b

ARG MEDUSA_BACKEND_URL
ARG NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_BASE_URL
ARG NEXT_PUBLIC_DEFAULT_REGION
ENV MEDUSA_BACKEND_URL=$MEDUSA_BACKEND_URL \
    NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=$NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY \
    NEXT_PUBLIC_BASE_URL=$NEXT_PUBLIC_BASE_URL \
    NEXT_PUBLIC_DEFAULT_REGION=$NEXT_PUBLIC_DEFAULT_REGION

RUN npm run build --workspace=@dtc/storefront-brand-b

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/apps/storefront-brand-b ./apps/storefront-brand-b

WORKDIR /repo/apps/storefront-brand-b
EXPOSE 8001
CMD ["npm", "run", "start"]
