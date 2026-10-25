# Team MCP gateway for a WooCommerce store

A WooCommerce store and a team MCP gateway on Kubernetes. Admins register MCP servers once in a dashboard. Each team member then uses all of their tools through one MCP endpoint with a personal API key, or through a Claude chat agent in the dashboard. Every tool call is audited.

What runs in the cluster:

| Namespace | Workloads | Public URL |
|---|---|---|
| `store` | WordPress + WooCommerce, MariaDB, setup Job, `woo-mcp` (the WooCommerce MCP server in this repo) | `store.<domain>` (storefront and wp-admin) |
| `gateway` | gateway (backend, MCP endpoint, chat agent, dashboard), store provisioner, PostgreSQL, `notes-mcp`, `server-everything` | `app.<domain>` (dashboard, `/api`, `/mcp`) |
| `store-<slug>`, one per store created on the Stores page | the same as `store`, installed by the provisioner from the same chart | `store-<slug>.<domain>` |

`woo-mcp`, the databases and the two extra upstreams have no Ingress and accept traffic only from their own clients (NetworkPolicies). How it works and why: [docs/design.md](docs/design.md). Risks and limits: [docs/threat-model.md](docs/threat-model.md).

Optional work: multi-store provisioning is implemented. Members create and delete stores on the dashboard's Stores page, and each store is registered in the gateway on its own; see [Create and delete stores](#create-and-delete-stores) and "Multi-store provisioning" in [docs/design.md](docs/design.md). Of the other stand-out items, these are done in part:

- Upgrades and rollback: Helm upgrade with automatic rollback, tested with a bad image tag; see [Upgrades, rollback and backups](#upgrades-rollback-and-backups) and "Upgrade and rollback" in [docs/design.md](docs/design.md).
- Security hardening: default-deny ingress NetworkPolicies in both namespaces, and non-root containers with all capabilities dropped (one init container runs as root with only `CHOWN`). Only the store provisioner uses the Kubernetes API. Its RBAC grants nothing in existing namespaces, and an admission policy limits it to the namespaces it created. The gateway, woo-mcp and upstream pods mount no service account token. Not done: an SSRF guard for upstream URLs and encryption of upstream credentials at rest ([docs/threat-model.md](docs/threat-model.md)).
- Observability: the Servers page shows why an upstream is Unreachable, and each audit entry gives the reason a call failed or was rejected. There are no metrics.
- Production-like deployment: `values-prod.yaml` and the [VPS setup](#vps-setup-k3s) steps, rehearsed on a k3s test cluster but not deployed to a public VPS.

Not attempted: tool permissions per role or user, OAuth on the gateway, search-then-execute for many tools, hosting MCP servers from container images, and more than one gateway replica or rate limits.

## Requirements

- Docker
- [k3d](https://k3d.io) 5.x (local cluster) or a VPS for [k3s](https://k3s.io)
- kubectl and Helm 4 (with Helm 3, replace `--rollback-on-failure` with `--atomic`)
- openssl, for generating secrets
- A Claude API key for the chat agent

## Local setup

All commands run from the repository root.

### 1. Create the cluster

```sh
k3d cluster create urumi --image rancher/k3s:v1.36.5-k3s1 -p "80:80@loadbalancer"
```

This maps port 80 on your machine to the cluster's Traefik Ingress controller. k3s enforces NetworkPolicies out of the box.

### 2. Build and load the images

```sh
docker build -f woo-mcp/Dockerfile -t urumi/woo-mcp:0.1.0 .
docker build -f notes-mcp/Dockerfile -t urumi/notes-mcp:0.1.0 .
docker build -f everything/Dockerfile -t urumi/everything:2.0.0 .
docker build -f gateway/Dockerfile -t urumi/gateway:0.2.0 .
k3d image import -c urumi urumi/woo-mcp:0.1.0 urumi/notes-mcp:0.1.0 urumi/everything:2.0.0 urumi/gateway:0.2.0
```

The gateway image also contains the built dashboard.

### 3. Create the Secrets

Credentials live only in Kubernetes Secrets, created before installing. The charts refer to them by name.

```sh
kubectl create namespace store
kubectl -n store create secret generic store-credentials \
  --from-literal=MARIADB_ROOT_PASSWORD="$(openssl rand -hex 24)" \
  --from-literal=MARIADB_PASSWORD="$(openssl rand -hex 24)" \
  --from-literal=WORDPRESS_ADMIN_PASSWORD="$(openssl rand -base64 18)" \
  --from-literal=WC_CONSUMER_KEY="ck_$(openssl rand -hex 20)" \
  --from-literal=WC_CONSUMER_SECRET="cs_$(openssl rand -hex 20)" \
  $(for k in AUTH_KEY SECURE_AUTH_KEY LOGGED_IN_KEY NONCE_KEY AUTH_SALT SECURE_AUTH_SALT LOGGED_IN_SALT NONCE_SALT; do echo "--from-literal=WORDPRESS_$k=$(openssl rand -hex 32)"; done)

kubectl create namespace gateway
kubectl -n gateway create secret generic gateway-credentials \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -hex 24)" \
  --from-literal=BOOTSTRAP_ADMIN_EMAIL=you@example.com \
  --from-literal=BOOTSTRAP_ADMIN_PASSWORD="$(openssl rand -base64 18)"
kubectl -n gateway create secret generic notes-credentials \
  --from-literal=NOTES_TOKEN="$(openssl rand -hex 32)"

# Paste the Claude API key at the prompt, so it stays out of your shell history.
read -rs ANTHROPIC_API_KEY
kubectl -n gateway create secret generic llm-credentials --from-literal=ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"
unset ANTHROPIC_API_KEY
```

| Secret | Keys | Used by |
|---|---|---|
| `store-credentials` | MariaDB passwords, WordPress admin password and salts, the WooCommerce REST key and secret for woo-mcp | MariaDB, WordPress, setup Job, woo-mcp |
| `gateway-credentials` | PostgreSQL password, first admin's email and password | PostgreSQL, gateway |
| `notes-credentials` | `NOTES_TOKEN`, the bearer token notes-mcp requires | notes-mcp; an admin enters the same value in the dashboard |
| `llm-credentials` | `ANTHROPIC_API_KEY` | the chat agent |

To read a value back, for example the first admin's password:

```sh
kubectl -n gateway get secret gateway-credentials -o jsonpath='{.data.BOOTSTRAP_ADMIN_PASSWORD}' | base64 -d; echo
```

### 4. Install the charts

```sh
helm upgrade --install store charts/store -n store -f charts/store/values-local.yaml --rollback-on-failure --timeout 10m
helm upgrade --install gateway charts/gateway -n gateway -f charts/gateway/values-local.yaml --rollback-on-failure --timeout 10m
```

The store chart's setup Job installs WordPress and WooCommerce, enables cash on delivery, stores the REST key for woo-mcp and adds two sample products. It runs on every install and upgrade, and every step is safe to repeat: it creates what is missing and resets the store settings it manages (timezone, permalinks, currency, country, coming-soon mode, shipping) to the chart values. No step in wp-admin is needed, and a change to those settings made in wp-admin is undone by the next upgrade. On a fresh install the Job log shows `sendmail: can't connect to remote host (127.0.0.1)` while it enables cash on delivery: that step tries to send an email, and the cluster has no mail server. Nothing depends on that email.

### 5. Open the store and the dashboard

- Storefront: http://store.localtest.me. wp-admin: http://store.localtest.me/wp-admin, user `admin`, password `WORDPRESS_ADMIN_PASSWORD`.
- Dashboard: http://app.localtest.me, signed in with `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`.

WooCommerce is registered as a server on the gateway's first start. Add the other two on the Servers page with **Add server**:

| Name | URL | Credential |
|---|---|---|
| Notes | `http://notes-mcp:3000/mcp` | Bearer token, the value of `NOTES_TOKEN` |
| Everything | `http://everything:3001/mcp` | None |

All three should show **Connected** with their tools.

### Local domain approach

`localtest.me` is a public DNS name whose every subdomain resolves to 127.0.0.1, so `store.localtest.me` and `app.localtest.me` reach the k3d load balancer on port 80 without any local configuration, from browsers and from command-line MCP clients alike. If you are offline or your DNS resolver filters such answers, add this line to `/etc/hosts`:

```
127.0.0.1 store.localtest.me app.localtest.me
```

## Using it

### Place an order

On the storefront, add a product to the cart, go to checkout, fill in the address and place the order with **Cash on delivery**. The order appears in wp-admin under **WooCommerce > Orders**.

### Invite a member and create an API key

1. As an admin, open **Members**, enter the person's email and role, and select **Create invite link**. The link is shown once and expires in 72 hours; the gateway sends no email, so pass it on yourself.
2. The invitee opens the link, sets a name and password, and is signed in.
3. On **API keys**, the member selects **Create key**. The key (`urk_...`) is shown once; the gateway stores only its hash. Admins can also create a key for a member and revoke any key.

### Connect an external MCP client

The **Connect a client** page shows the Claude Code command, the Cursor configuration and the first Inspector command with the right URL filled in. Replace `<your API key>` with a key from the API keys page.

Claude Code:

```sh
claude mcp add --transport http team-gateway http://app.localtest.me/mcp --header "Authorization: Bearer <your API key>"
```

Cursor (`.cursor/mcp.json` in a project, or `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "team-gateway": {
      "url": "http://app.localtest.me/mcp",
      "headers": { "Authorization": "Bearer <your API key>" }
    }
  }
}
```

MCP Inspector, from a terminal:

```sh
npx @modelcontextprotocol/inspector@2.12.0 --cli http://app.localtest.me/mcp --transport http \
  --header "Authorization: Bearer <your API key>" --method tools/list
npx @modelcontextprotocol/inspector@2.12.0 --cli http://app.localtest.me/mcp --transport http \
  --header "Authorization: Bearer <your API key>" --method tools/call --tool-name list_orders --tool-arg after=YYYY-MM-DDT00:00:00
```

In the second command, replace `YYYY-MM-DD` with today's date. `after` is in store time, so this lists today's orders.

The client sees the tools of every enabled, connected server. Tool names are the servers' own (`list_orders`, `save_note`); only when two servers expose the same name are both renamed to `<slug>__<name>`, and the Servers page says why.

A revoked key gets HTTP 401 on its next request. MCP Inspector then reports `auth_required`, because it reads the 401 as a request to sign in with OAuth.

### Use the chat agent

Open **Chat** and ask, for example:

- "Create a product called 'Desk Lamp' priced 1299." It then shows on the storefront.
- "Which orders came in today?"
- "Look up today's orders in the store and save a note called 'Orders today' that lists each order's number, customer and total." This uses WooCommerce and Notes in one answer.

Each tool call is shown under the answer with its arguments and result, and is recorded in the audit log under the signed-in member, marked **Chat**. The conversation lives in the page; leaving it ends the conversation and stops an answer that is still running.

### Disable a server, or kill one

- On **Servers**, **Disable** removes a server's tools from every client's next tool list and from the chat agent's next message. **Enable** brings them back.
- To see a dead upstream, stop its pod and watch the Servers page show **Unreachable** within about 15 seconds, while the other servers keep working:

  ```sh
  kubectl -n gateway scale deploy/notes-mcp --replicas=0
  kubectl -n gateway scale deploy/notes-mcp --replicas=1   # back to Connected within a refresh
  ```

  Deleting the pod instead also works, but its replacement starts within seconds, so the Unreachable state is easy to miss.

### Audit log

**Audit log** lists every tool call, newest first: time, member, whether it came from an MCP client or the chat, server, tool, outcome (succeeded, failed, timed out, rejected), duration and reason. Rejected requests are included, such as a call with a revoked key, which is listed under the key's owner. Admins see everyone's calls; members see their own.

### Show a name collision

Add Notes a second time on the Servers page, with slug `notes2`, the same URL and token. All three notes tools on both entries become `notes__...` and `notes2__...`, and calls go to the right one. Remove the copy and the plain names come back.

### Create and delete stores

On the **Stores** page, enter a name such as `Delhi` and click **Create store**. The store appears as Provisioning. The provisioner creates the namespace `store-delhi` with its own generated Secret, then installs the store chart there: MariaDB, WordPress, the setup Job and woo-mcp, each with its own volumes, plus an Ingress for `http://store-delhi.localtest.me`. Within a few minutes the store shows Ready. The gateway picks up its woo-mcp within 15 seconds, and its tools appear on the Servers page as `delhi__list_orders`, `delhi__create_product` and so on. Several stores can be created at once. Creating a store with a name you already used returns that store instead of starting a second one.

Store tools always carry the store's slug. While any store exists, the original store's tools collide with them and become `woocommerce__list_orders` and so on, under the collision rule.

Each member can have up to 3 stores (`stores.maxPerMember`). A store that is not Ready within 15 minutes (`stores.provisionTimeoutMinutes`) is marked Failed with the reason, and **Retry** starts a new attempt. If the provisioner restarts in the middle, the next one resumes the store: a half-installed release is removed and installed again, and the Secret and volumes are kept.

**Delete** removes the store's tools from every client at once. Then the provisioner deletes the namespace, which removes the release, the volumes and the Secrets, and the store disappears from the list. Members can delete their own stores, and admins can delete any store.

To compare two stores, create `Delhi` and `Pune`, place an order on each storefront, and ask the chat agent: "Compare today's orders in the Delhi and Pune stores." It calls `delhi__list_orders` and `pune__list_orders`. Delete `Pune`, and its tools are gone from the chat agent and from connected clients.

To sign in to a store's wp-admin as `admin`, read its generated password:

```sh
kubectl -n store-delhi get secret store-credentials -o jsonpath='{.data.WORDPRESS_ADMIN_PASSWORD}' | base64 -d; echo
```

Every store namespace has a ResourceQuota and a LimitRange from the store chart (`quota` and `limitRange` in `charts/store/values.yaml`):

```sh
kubectl -n store-delhi describe resourcequota store
```

A store's woo-mcp can reach only its own WordPress and DNS, and a store's database and WordPress accept connections only from their own namespace (and WordPress from the Ingress controller). From Delhi's woo-mcp, Delhi's WordPress answers and Pune's is refused:

```sh
kubectl -n store-delhi exec deploy/woo-mcp -- node -e '
for (const host of ["wordpress.store-delhi", "wordpress.store-pune", "mariadb-0.mariadb.store-pune"]) {
  const s = require("net").connect({ host: host + ".svc.cluster.local", port: host.startsWith("mariadb") ? 3306 : 80, timeout: 3000 });
  s.on("connect", () => { console.log(host, "open"); s.destroy(); });
  s.on("error", (e) => console.log(host, e.code));
  s.on("timeout", () => { console.log(host, "timeout"); s.destroy(); });
}'
```

### Check that woo-mcp is internal

There is no Ingress for woo-mcp, and its NetworkPolicy admits only the gateway's pods. From any other pod the connection fails, for example from a throwaway pod in the `default` namespace:

```sh
kubectl run probe --rm -it --restart=Never --image=postgres:18.6-alpine3.24 -- \
  wget -T 5 -qO- http://woo-mcp.store.svc.cluster.local:3000/healthz
```

`wget` fails with `Connection refused`, because kube-router rejects the connection, while the gateway's calls to WooCommerce keep working.

## VPS setup (k3s)

The same charts, with `values-prod.yaml` instead of `values-local.yaml`.

These steps are documented but were not run on a public VPS. They were rehearsed on a k3s test cluster in the build environment: a fresh install of both charts from `values-prod.yaml`, with test hostnames and the namespace wiring set with `--set` and the images loaded under their GHCR names. The two-user acceptance run passed there, with a stand-in for the Claude API. The GHCR push, DNS records, firewall and SSH tunnel below have not been tested, and the hostnames in `values-prod.yaml` stay empty until a VPS exists.

### 1. Install k3s

On the VPS (Ubuntu or Debian). Plan for about 4 GB of memory: the workloads' memory limits in `values-prod.yaml` add up to about 3.7 GiB, plus k3s itself. This is an estimate, not a tested minimum.

```sh
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=v1.36.5+k3s1 sh -
```

k3s includes Traefik and the `local-path` storage class, which the charts use. Open ports 22 and 80 in the VPS firewall. Keep the Kubernetes API port 6443 closed to the internet and reach it through SSH instead:

```sh
scp root@<vps>:/etc/rancher/k3s/k3s.yaml ~/.kube/urumi-vps.yaml   # server stays https://127.0.0.1:6443
ssh -N -L 6443:127.0.0.1:6443 root@<vps> &
export KUBECONFIG=~/.kube/urumi-vps.yaml
```

### 2. Push the images to GHCR

Create a GitHub personal access token with `write:packages`, then:

```sh
echo "<token>" | docker login ghcr.io -u kajal-jotwani --password-stdin
docker buildx build --platform linux/amd64 -f woo-mcp/Dockerfile -t ghcr.io/kajal-jotwani/woo-mcp:0.1.0 --push .
docker buildx build --platform linux/amd64 -f notes-mcp/Dockerfile -t ghcr.io/kajal-jotwani/notes-mcp:0.1.0 --push .
docker buildx build --platform linux/amd64 -f everything/Dockerfile -t ghcr.io/kajal-jotwani/everything:2.0.0 --push .
docker buildx build --platform linux/amd64 -f gateway/Dockerfile -t ghcr.io/kajal-jotwani/gateway:0.2.0 --push .
```

Use `linux/arm64` if the VPS has an ARM processor. On GitHub, open each package's settings and set its visibility to public: the charts use no image pull secret.

### 3. Point two hostnames at the VPS

Create DNS A records for `store.<your-domain>` and `app.<your-domain>` with the VPS's IP address, and a wildcard record `*.<your-domain>` for the stores members create. Without a domain, use `store.<vps-ip>.sslip.io` and `app.<vps-ip>.sslip.io`, which resolve to that IP with no setup, as does every `store-<slug>.<vps-ip>.sslip.io`.

Set them in the values files:

- `charts/store/values-prod.yaml`: `store.url: http://store.<your-domain>`
- `charts/gateway/values-prod.yaml`: `publicUrl: http://app.<your-domain>` and `stores.domain: <your-domain>`

The charts refuse to render while these are empty.

### 4. Create the Secrets and install

Run the commands from [step 3 of the local setup](#3-create-the-secrets) against the VPS cluster. They generate new random values. Then:

```sh
helm upgrade --install store charts/store -n store -f charts/store/values-prod.yaml --rollback-on-failure --timeout 10m
helm upgrade --install gateway charts/gateway -n gateway -f charts/gateway/values-prod.yaml --rollback-on-failure --timeout 10m
```

Add the Notes and Everything servers in the dashboard as in [step 5](#5-open-the-store-and-the-dashboard).

The charts serve plain HTTP. On a public VPS, passwords and API keys then cross the internet unencrypted; adding TLS (Traefik with Let's Encrypt) is the first extension to make before real use.

## Upgrades, rollback and backups

- Upgrade by changing values or image tags and running the same `helm upgrade --install` command. `--rollback-on-failure` returns to the previous revision if the new pods do not become ready.
- Roll back by hand with `helm history <release> -n <namespace>` and `helm rollback <release> <revision> -n <namespace>`.
- The MariaDB, PostgreSQL and `wp-content` volumes survive `helm uninstall` and failed upgrades.
- Before changing the WooCommerce version, back up the store database; WooCommerce's own schema changes cannot be rolled back by Helm:

  ```sh
  kubectl -n store exec mariadb-0 -- sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction wordpress' > store-backup.sql
  kubectl -n gateway exec postgres-0 -- pg_dump -U gateway gateway > gateway-backup.sql
  ```

- `helm rollback` does not undo a WooCommerce version change. The setup Job runs after install and upgrade but not after a rollback, and WooCommerce has already migrated its tables. To go back, run `helm upgrade` with the previous `woocommerceVersion` (the Job reinstalls that version), then restore the dump. This restore command has not been tested:

  ```sh
  kubectl -n store exec -i mariadb-0 -- sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" wordpress' < store-backup.sql
  ```

## Development

The four Node packages (`woo-mcp`, `notes-mcp`, `gateway`, `dashboard`) are npm workspaces. With Node 24:

```sh
npm ci
npm test               # Vitest; gateway tests use PGlite, so no database is needed
npm run lint
npm run typecheck
npm run format:check
```

| Path | Contents |
|---|---|
| `charts/store/` | MariaDB, WordPress, setup Job, woo-mcp, their NetworkPolicies |
| `charts/gateway/` | gateway, PostgreSQL, notes-mcp, server-everything, their NetworkPolicies |
| `woo-mcp/` | WooCommerce MCP server: five tools over the WooCommerce REST API |
| `notes-mcp/` | notes MCP server, the third upstream |
| `everything/` | image for the MCP reference server, the second upstream |
| `gateway/` | backend: MCP endpoint, upstream registry, members, keys, audit, chat agent |
| `dashboard/` | React dashboard, built into the gateway image |
