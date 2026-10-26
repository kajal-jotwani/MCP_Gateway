# Build from the repository root: docker build -f gateway/Dockerfile .
# The same image runs the gateway and the provisioner, which needs helm, the store chart and the
# hosted server chart.
FROM alpine/helm:4.3.1 AS helm

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
COPY --from=helm /usr/bin/helm /usr/local/bin/helm
COPY charts/store charts/store
COPY charts/hosted-mcp charts/hosted-mcp
USER node
EXPOSE 8080
CMD ["node", "gateway/dist/main.js"]
