# Build from the repository root: docker build -f woo-mcp/Dockerfile .
FROM node:24.22.1-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY woo-mcp/package.json woo-mcp/
RUN npm ci --workspace woo-mcp --include-workspace-root
COPY woo-mcp woo-mcp
RUN npm run build --workspace woo-mcp

FROM node:24.22.1-alpine3.24
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY woo-mcp/package.json woo-mcp/
RUN npm ci --workspace woo-mcp --omit=dev && npm cache clean --force
COPY --from=build /app/woo-mcp/dist woo-mcp/dist
USER node
EXPOSE 3000
CMD ["node", "woo-mcp/dist/main.js"]
