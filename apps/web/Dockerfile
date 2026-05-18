# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS dev
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages ./packages/
COPY apps/web ./apps/web/
RUN npm ci
EXPOSE 5173
CMD ["npm", "run", "dev", "-w", "apps/web", "--", "--host", "0.0.0.0"]

FROM node:20-alpine AS build
WORKDIR /app
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages ./packages/
RUN npm ci
COPY apps/web ./apps/web/
RUN npm run build -w apps/web

FROM nginx:alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
