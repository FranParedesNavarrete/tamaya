# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS dev
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/worker-resolve/package.json apps/worker-resolve/
COPY packages ./packages/
COPY apps/worker-resolve ./apps/worker-resolve/
RUN npm ci
CMD ["npm", "run", "dev", "-w", "apps/worker-resolve"]

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/worker-resolve/package.json apps/worker-resolve/
COPY packages ./packages/
RUN npm ci
COPY apps/worker-resolve ./apps/worker-resolve/
RUN npm run build -w packages/db
RUN npm run build -w packages/media-resolver
RUN npm run build -w packages/shared-types
RUN npm run build -w apps/worker-resolve

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/worker-resolve/dist ./apps/worker-resolve/dist
COPY --from=build /app/apps/worker-resolve/package.json ./apps/worker-resolve/
COPY --from=build /app/packages ./packages/
COPY --from=build /app/node_modules ./node_modules
USER node
CMD ["node", "apps/worker-resolve/dist/index.js"]
