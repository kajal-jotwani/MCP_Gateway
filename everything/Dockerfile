# The MCP reference server, pinned by package-lock.json. Build from the repository root:
# docker build -f everything/Dockerfile .
FROM node:24.22.1-alpine3.24
WORKDIR /app
ENV NODE_ENV=production
COPY everything/package.json everything/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
USER node
EXPOSE 3001
CMD ["node", "node_modules/@modelcontextprotocol/server-everything/dist/index.js", "streamableHttp"]
