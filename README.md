# MCP Gateway on Kubernetes

WooCommerce hosting with a team MCP gateway.

## Repository layout

```
apps/
  woocommerce-mcp/   WooCommerce MCP server (Streamable HTTP, cluster-internal only)
  gateway/           Backend: MCP gateway, admin/team API, audit log, chat agent
  dashboard/         React dashboard
  upstreams/         The two additional upstream MCP servers
deploy/
  helm/platform/     Chart: gateway, dashboard, gateway DB, extra upstreams
  helm/store/        Chart: WordPress + WooCommerce + MariaDB + WooCommerce MCP
  kind/              Local cluster config
scripts/             Setup and seed helpers
tests/e2e/           Definition-of-done flow tests
docs/                Design, threat model, deployment notes
```

## Local setup

## VPS / production setup (k3s)

## Placing an order

## Connecting an external MCP client

## Using the chat agent

## Bonus and stand-out items
