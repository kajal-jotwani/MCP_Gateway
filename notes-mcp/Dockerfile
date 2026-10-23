# Build from the repository root: docker build -f notes-mcp/Dockerfile .
FROM node:24.22.1-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY notes-mcp/package.json notes-mcp/
RUN npm ci --workspace notes-mcp --include-workspace-root
COPY notes-mcp notes-mcp
RUN npm run build --workspace notes-mcp

FROM node:24.22.1-alpine3.24
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY notes-mcp/package.json notes-mcp/
RUN npm ci --workspace notes-mcp --omit=dev && npm cache clean --force
COPY --from=build /app/notes-mcp/dist notes-mcp/dist
USER node
EXPOSE 3000
CMD ["node", "notes-mcp/dist/main.js"]
