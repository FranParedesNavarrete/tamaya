# syntax=docker/dockerfile:1.7

# --- dev stage (con hot reload) ---
FROM node:20-alpine AS dev
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages ./packages/
COPY apps/api ./apps/api/
RUN npm ci
EXPOSE 3001
CMD ["npm", "run", "dev", "-w", "apps/api"]

# --- build stage ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages ./packages/
RUN npm ci
COPY apps/api ./apps/api/
RUN npm run build -w packages/db
RUN npm run build -w packages/shared-types
RUN npm run build -w apps/api

# --- runtime ---
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/packages ./packages/
COPY --from=build /app/node_modules ./node_modules
EXPOSE 3001
USER node
CMD ["node", "apps/api/dist/server.js"]
