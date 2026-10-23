# Build from the repository root: docker build -f gateway/Dockerfile .
FROM node:24.22.1-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY gateway/package.json gateway/
COPY dashboard/package.json dashboard/
RUN npm ci --workspace gateway --workspace dashboard --include-workspace-root
COPY gateway gateway
COPY dashboard dashboard
RUN npm run build --workspace gateway --workspace dashboard

FROM node:24.22.1-alpine3.24
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY gateway/package.json gateway/
RUN npm ci --workspace gateway --omit=dev && npm cache clean --force
COPY --from=build /app/gateway/dist gateway/dist
COPY --from=build /app/dashboard/dist dashboard/dist
COPY gateway/migrations gateway/migrations
USER node
EXPOSE 8080
CMD ["node", "gateway/dist/main.js"]
