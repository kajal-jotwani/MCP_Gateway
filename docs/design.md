# Design

Status: draft for review. Nothing is implemented yet. Statements marked **Verified** were checked against docs or package contents on 2026-10-23. Statements marked **To verify** are assumptions that get checked in the stage named next to them.

## Components

| Component | Runs as | Responsibility |
|---|---|---|
| MariaDB | StatefulSet, PVC, namespace `store` | Store database |
| WordPress + WooCommerce | Deployment (1 replica), PVC for `wp-content`, namespace `store` | Storefront and wp-admin |
| Store setup Job | Helm post-install/post-upgrade hook, namespace `store` | Installs WordPress, WooCommerce, COD and the REST key, idempotently |
| `woo-mcp` | Deployment, ClusterIP Service, namespace `store` | MCP server written here. Five tools over the WooCommerce REST API |
| `gateway` | Deployment (1 replica), namespace `gateway` | MCP endpoint for clients, MCP client to every upstream, auth, audit, chat agent, dashboard API, serves the built dashboard |
| PostgreSQL | StatefulSet, PVC, namespace `gateway` | Members, sessions, invites, API keys, upstreams, audit entries |
| `server-everything` | Deployment, namespace `upstreams` | Second upstream: the official MCP reference server |
| `notes-mcp` | Deployment, namespace `upstreams` | Third upstream, written here: a small notes server that requires a bearer token |

The dashboard (`dashboard/`, React + Vite) is built into the gateway image and served by the gateway from the same origin as `/api` and `/mcp`. One origin means no CORS and one Ingress host.

Stack: TypeScript on Node 24 LTS, Express 5, the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`, `@modelcontextprotocol/client`, `@modelcontextprotocol/express`, all 2.x), `pg` with plain SQL migrations, Vitest, ESLint and Prettier.

**Verified:** SDK v2 is the current stable line and implements the 2026-07-28 spec. It also serves 2025-era clients (`initialize` handshake) statelessly by default (`createMcpHandler`, `legacy: 'stateless'`). SDK v1 (`@modelcontextprotocol/sdk` 1.32.x) is the maintenance line and stops at 2025-11-25. Using v2 lets the gateway talk to both new and older clients and upstreams.

### Repository layout

```
charts/store/      MariaDB, WordPress, setup Job, woo-mcp
charts/gateway/    gateway, PostgreSQL, the two extra upstreams
woo-mcp/           WooCommerce MCP server
notes-mcp/         notes MCP server (third upstream)
gateway/           backend: MCP endpoint, upstream client, auth, audit, chat agent
dashboard/         React frontend
docs/              design.md, threat-model.md
```

`notes-mcp/` is an addition to the layout in CLAUDE.md, needed for G6.

Two charts instead of one: the store chart is the unit that the multi-store bonus would install per store, and the gateway does not need to be reinstalled when a store changes. Each chart has `values.yaml`, `values-local.yaml` and `values-prod.yaml`.

## Decisions

### How woo-mcp talks to WooCommerce

| Option | For | Against |
|---|---|---|
| REST API (`/wp-json/wc/v3`) | Stable, versioned, documented; runs WooCommerce's validation, hooks and stock logic; needs only HTTP | Needs a credential and request signing over plain HTTP |
| WP-CLI | No HTTP auth | Needs the WordPress files and PHP in the MCP pod, or `kubectl exec` rights; slow per call |
| Direct database | Fast | Skips WooCommerce logic (stock, totals, order notes, HPOS tables); breaks on schema changes |

**Decision: REST API v3** over the in-cluster Service `http://wordpress.store.svc.cluster.local`.

WooCommerce accepts HTTP Basic auth with a consumer key and secret only over HTTPS. Over plain HTTP it requires OAuth 1.0a one-legged signing. Traffic between pods is plain HTTP, so woo-mcp signs each request with OAuth 1.0a (HMAC-SHA256, Node `crypto`, about 40 lines, unit-tested against WooCommerce's documented example). The alternative, faking `is_ssl()` with a mu-plugin, changes WordPress behavior for every request and is harder to defend. **To verify (stage 2):** signing works against the pinned WooCommerce version.

Tools (W3), each with a JSON Schema for input and validation at the boundary:

| Tool | REST call |
|---|---|
| `list_products` | `GET /products` (search, status, page, per_page ≤ 50) |
| `create_product` | `POST /products` (name, regular_price, optional description, status defaults to `publish`) |
| `list_orders` | `GET /orders` (after, before, status, page, per_page ≤ 50) |
| `get_order` | `GET /orders/{id}` |
| `update_order_status` | `PUT /orders/{id}` with `status` from WooCommerce's fixed list |

`list_orders` takes ISO dates and its description tells the model the store's timezone, so "orders that came in today" maps to an `after` value the model can compute. Results are trimmed to the fields a person needs (id, status, total, currency, date, customer name, line items), which keeps the LLM context small and leaves out customer addresses and emails.

### First deploy: a working store without manual steps

| Option | For | Against |
|---|---|---|
| Helm hook Job using the `wordpress:cli` image | Plain WP-CLI commands, idempotent, no custom image | Downloads WooCommerce from wordpress.org at install time |
| Custom WordPress image with WooCommerce baked in | No download at install | One more image to build, push and patch |
| Manual setup in wp-admin | None | Violates "helm install produces a working store" |

**Decision: post-install and post-upgrade hook Job** that waits for the database, then runs:

1. `wp core install` if not installed (site URL from values, admin user from the Secret).
2. `wp plugin install woocommerce --version=<pinned> --activate` if missing.
3. Store settings: currency, country, timezone, a `Shop` page; enable the COD gateway (`wp wc payment_gateway update cod --enabled=true`).
4. Insert the REST key from the Secret into `wp_woocommerce_api_keys` with `wp eval` (stored the way WooCommerce stores it: `wc_api_hash(consumer_key)`, the secret, and the last 7 characters) if a key with that hash does not exist. Read/write permission.
5. Create two sample products if the store has none.

Every step checks before acting, so the Job can run on every upgrade. Exact WordPress image tag, WooCommerce version and the `wp wc` command syntax are **To verify (stage 1)**.

**How credentials reach woo-mcp:** the operator creates one Secret, `store-credentials`, before install (commands in the README, values from `openssl rand`): DB passwords, WordPress admin password, `WC_CONSUMER_KEY` (`ck_` + 40 hex) and `WC_CONSUMER_SECRET` (`cs_` + 40 hex). MariaDB, WordPress, the setup Job and woo-mcp all reference keys from that Secret through `secretKeyRef`. Because the key is generated before WooCommerce exists and inserted by the Job, no one has to copy a key out of wp-admin. Charts take the Secret name as a value and never contain secret values.

Why operator-created Secrets instead of Helm generating them with `randAlphaNum` and `lookup`: `lookup` returns nothing under `helm template` and `--dry-run`, so generated values change on every render unless guarded, and the credentials end up in Helm release history. Creating Secrets with `kubectl` is one documented command and works the same locally and on the VPS.

### Upstream connections and status

| Option | For | Against |
|---|---|---|
| One long-lived MCP client per enabled upstream | Tool list can be cached; status known before a client asks; reuses HTTP connections | Must reconnect after failures |
| New connection per client request | No state | Every `tools/list` fans out to every upstream, so a slow upstream slows every listing |

**Decision: one long-lived client per enabled upstream,** owned by an upstream registry in the gateway process.

- On start, and when an admin adds, edits or enables an upstream, the registry connects (SDK negotiates the protocol era) and lists tools.
- Every 15 s a refresh loop lists tools on every enabled upstream in parallel, each with a 5 s timeout. Success sets **Connected** and replaces the cached tool list. Failure sets **Unreachable**, records the reason (timeout, connection refused, HTTP status, protocol error), and drops a broken client so the next refresh reconnects.
- A tool call that fails at the transport level marks that upstream Unreachable immediately, so the dashboard updates without waiting for the next refresh (D8).
- **Disabled** comes from the database. A disabled upstream has no client and no tools.
- If an upstream advertises `tools.listChanged`, the registry also re-lists on that notification.

### Tool-name namespacing

**Verified limits:**

- MCP spec 2026-07-28: names SHOULD be 1–128 characters from `A-Z a-z 0-9 _ - .`. The spec says aggregators SHOULD disambiguate, for example with a server prefix, and that `serverInfo.name` is not unique enough to use.
- Cursor: server config key plus tool name must be at most 60 characters, and dots are rejected (Cursor forum, staff replies).
- Claude API: tool names must match `^[a-zA-Z0-9_-]{1,128}$` (Anthropic tool-use docs). This applies to the chat agent and to Claude Code.
- Claude Code exposes MCP tools to the model as `mcp__<server>__<tool>`. With the README telling users to name the server `urumi`, that adds 12 characters. **To verify (stage 3):** the exact Claude Code prefix format with the current version.

Cursor's 60-character limit is the tightest of these.

**Decision:** every exposed tool is named `<prefix>__<tool>`.

- `prefix` belongs to the upstream record, not to the code. It defaults to a slug of the name the admin types (lowercase, `[a-z0-9-]`, 2–16 characters), the admin can override it, and it must be unique. No prefix is hard-coded anywhere, including for WooCommerce: the pre-registered store takes its name and prefix from gateway chart values (`store` by default). With the multi-store bonus, each store would register with its own name, so tool names say which store they act on.
- The admin can change a prefix later. That renames the upstream's tools for every client, so the dashboard warns before saving, and the gateway sends `list_changed` the same way as for a disable.
- `tool` is the upstream's name with any character outside `[A-Za-z0-9_-]` replaced by `_`.
- Every tool is prefixed, not only colliding ones. Names stay stable when a new upstream with an overlapping tool name is added. `store__list_orders` and `notes__list_orders` can both exist.
- Maximum exposed length is 48 characters. That leaves room for Cursor's 60 with a config key of up to 12 characters. A longer name is cut to 41 characters plus `_` plus the first 6 hex characters of the SHA-256 of the original name, so it stays unique and stable.
- If two upstream tools on the same upstream map to the same exposed name after sanitizing, both get the hash suffix.

**Mapping back:** the gateway never parses names to route. Each cache refresh builds a map from exposed name to `{upstreamId, originalName}`. `tools/call` looks the name up in that map, so the scheme can change without touching routing. The mapping function is pure and unit-tested (collisions, length, sanitizing, stability).

### How clients learn the tool list changed (D7)

The gateway's `tools/list` is built on each request from the current cache and the current enabled set in the database. So any client that lists again sees the change.

On top of that:

- **2026-07-28 clients** can open `subscriptions/listen` with `toolsListChanged`. When an upstream is enabled, disabled, removed, or its tool list changes, the gateway publishes `notifications/tools/list_changed` through the SDK handler's notification bus.
- **2025-era clients** are served statelessly, which means no standalone GET stream (**Verified:** the SDK returns 405 for legacy GET in this mode). They see the change on their next `tools/list`, for example a reconnect in Claude Code or "List Tools" in MCP Inspector.
- **Chat agent:** lists tools at the start of every turn, so a disabled upstream's tools are gone from the next message.

**Decision: both** push (for clients that subscribe) and per-request listing (for everyone). Keeping sessionful legacy support just for GET streams would make the gateway stateful for one feature. **To verify (stage 3):** which protocol era Claude Code, Cursor and MCP Inspector 2.x speak, and how each reacts.

### Timeouts, fan-out and caching

| Operation | Timeout | Why |
|---|---|---|
| Connect to an upstream | 5 s | A healthy in-cluster server answers in milliseconds |
| Upstream `tools/list` (refresh loop) | 5 s per upstream, all in parallel | A slow server costs its own timeout, not the whole refresh |
| Upstream `tools/call` | 30 s | Store writes can be slow; long enough for real work, short enough for an LLM loop |
| Client `tools/list` at the gateway | No upstream call | Served from cache, so a dead upstream cannot slow it |
| WooCommerce REST call inside woo-mcp | 20 s | Under the gateway's 30 s so woo-mcp can return a clear error first |

A timed-out call is cancelled (the SDK aborts the request) and returns an MCP tool error: `Upstream "notes" did not respond within 30 s.` Unreachable upstreams return `Upstream "notes" is unreachable.` Neither message includes URLs or credentials.

Cache invalidation: the per-upstream tool cache is replaced on every successful refresh, on admin edits, and on upstream `list_changed`. It is dropped when the upstream is disabled or removed. Tools from an Unreachable upstream are hidden from `tools/list`, because listing tools that will fail wastes the model's turns.

### Human login and invites

**Decision:** email and password with a server-side session.

- Passwords hashed with `crypto.scrypt` (Node built-in, N=2^15, r=8, p=1), so no native dependency.
- Login sets an `HttpOnly`, `SameSite=Lax` cookie holding a random session id. Sessions live in PostgreSQL with a 7-day expiry and are deleted on logout.
- State-changing dashboard requests require the cookie plus a custom header (`X-Requested-With`), which a cross-site form cannot send.
- The first admin is created at gateway start if no members exist, from the `gateway-bootstrap` Secret (email, password).

Invites without email: an admin enters an email and role, the gateway creates a one-time token (32 random bytes, stored as SHA-256, expires in 72 h) and shows a link `https://<dashboard>/invite/<token>` once. The admin sends the link any way they like. Opening it lets the invitee set a name and password. The token is deleted on use.

Alternatives considered: OAuth/OIDC login (needs an identity provider for a local demo; listed as a later extension), magic links (need email).

### API keys

Format: `urk_` followed by 32 bytes from `crypto.randomBytes`, base64url (43 characters). The first 8 characters after `urk_` are stored in clear as a display prefix so members can tell keys apart.

Storage: SHA-256 of the full key, with a unique index. Verification hashes the presented key and looks it up, then checks `revoked_at IS NULL` and that the member is active. There is no cache, so revocation applies on the next call (D6).

Why a fast hash: password hashes (scrypt, argon2) exist to slow down guessing of low-entropy secrets. A key with 256 bits of randomness cannot be guessed whatever the hash speed, so a slow hash would only add tens of milliseconds and CPU to every MCP request. SHA-256 also allows lookup by hash, so there is no per-key comparison loop and no timing signal on the secret.

Keys are shown once on creation. Members create and revoke their own keys. Admins can create a key for a member (shown once to the admin) and revoke any key.

### Chat agent as the logged-in member

The gateway has one function for each step every tool call goes through:

1. `authorizeToolCall(member, exposedName)`: member is active, role allows tool use.
2. `routeToolCall(exposedName)`: map lookup to upstream and original name; rejects unknown and disabled.
3. `callUpstreamTool(...)`: timeout and error mapping.
4. `writeAuditEntry(...)`: always, in a `finally`, including rejections.

The MCP endpoint resolves the member from the API key and calls this path. The chat endpoint (`POST /api/chat`) resolves the member from the session cookie and calls the same path with `via = chat`. There is no other code that calls upstreams.

LLM: the Claude API through the official TypeScript SDK (`@anthropic-ai/sdk`, pinned). The model is a chart value, default `claude-opus-5-5`. The API key is the `ANTHROPIC_API_KEY` entry of the `llm-credentials` Secret (C3).

The chat loop is a manual loop over the Messages API rather than the SDK's tool runner, because every tool execution has to go through the gateway's own path and the loop is short enough to read in one screen:

1. List tools for the member and convert each to a Claude tool (`name`, `description`, `input_schema`). Exposed names already match the Claude API's name rule.
2. Call `messages.create` with the system prompt, the conversation, the tools, `tool_choice: auto`, adaptive thinking (Opus 5.5 does not allow thinking to be turned off) and `effort: low`, which is enough to pick among a few tools and keeps cost and latency down.
3. If `stop_reason` is `refusal` or `max_tokens`, stop and show a clear message; tools from a cut-off turn are not run.
4. Run every `tool_use` block in the response in parallel through the path above, then send all `tool_result` blocks back in one user message, with `is_error: true` for failed, timed-out or rejected calls.
5. Repeat until `stop_reason` is `end_turn`, at most 8 rounds.

The server-side refusal fallback (`fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta) is enabled, so a rare policy decline is retried on another model inside the same call instead of failing the turn.

The browser receives a server-sent event stream with the assistant text and each tool call (name, arguments, outcome, duration) as it happens, so the UI shows which tools ran (C1). The conversation is kept in the browser and sent with each message; the gateway stores only audit entries. The system prompt tells the model that tool descriptions and results are data from third-party servers and never instructions.

Alternative considered: the agent connects to the gateway's own `/mcp` with a key minted for the member. That proves the external path, but needs a hidden key per member and an HTTP hop for nothing. The shared function gives the same guarantee and is easier to test.

### Additional upstreams and the D5 prompt

| Upstream | Prefix | Where | Credential |
|---|---|---|---|
| WooCommerce (`woo-mcp`) | `store` (from values) | namespace `store` | none at the MCP layer; NetworkPolicy restricts callers |
| MCP reference server (`@modelcontextprotocol/server-everything`, Streamable HTTP mode) | `everything` | namespace `upstreams` | none |
| `notes-mcp` (in repo): `save_note`, `list_notes`, `search_notes`, notes in memory | `notes` | namespace `upstreams` | bearer token from a Secret, entered by the admin in the dashboard (exercises G1 and G5) |

`server-everything` is useful for failure tests because it has tools that sleep and that return errors. **To verify (stage 3):** its Streamable HTTP start command and tool names in the pinned version.

D5 prompt: "Look up today's orders in the store and save a note called 'Orders today' that lists each order's number, customer and total." This needs `store__list_orders` and `notes__save_note`.

### Gateway database

| Option | For | Against |
|---|---|---|
| PostgreSQL | Concurrent writes, works with more replicas later | One more StatefulSet |
| SQLite on a PVC | No extra workload | One writer; a second replica cannot share it |

**Decision: PostgreSQL** (official image, pinned tag), StatefulSet with a PVC in namespace `gateway`. Migrations are plain SQL files applied at gateway start inside a transaction with an advisory lock.

### Ingress and local domains

**Decision: Traefik,** which ships with k3s and k3d, so local and VPS use the same controller and the same Ingress objects.

Local hostnames: `store.localtest.me` and `app.localtest.me`. `localtest.me` and every subdomain resolve to 127.0.0.1 in public DNS, so browsers and CLI clients work without editing `/etc/hosts` (**To verify (stage 1):** resolution on Kajal's Mac; this container has no outside DNS). The k3d cluster maps host port 80 to its load balancer. Offline fallback, documented in the README: add both names to `/etc/hosts`.

`*.localhost` was rejected because some resolvers outside browsers do not resolve subdomains of `localhost`, which would break CLI MCP clients. `.local` was rejected because macOS sends it to mDNS.

WordPress `siteurl` is `http://store.localtest.me`. Inside the pod that name resolves to the pod itself, where Apache listens on 80, so WordPress loopback requests still work. woo-mcp calls the Service name instead.

`app.localtest.me` routes `/` (dashboard), `/api` and `/mcp` to the gateway. There is no Ingress for woo-mcp, notes-mcp, server-everything or either database.

### NetworkPolicies on the local cluster

**Decision: k3d.** k3s includes an embedded network policy controller (kube-router) next to flannel, so NetworkPolicies are enforced locally and on the VPS with the same objects, and the local cluster matches the VPS distribution.

Policies (default deny ingress per namespace, then allow):

- `woo-mcp`: from pods labeled `app.kubernetes.io/name=gateway` in namespace `gateway` only, on its port.
- `wordpress`: from the Ingress controller namespace and from `woo-mcp`.
- `mariadb`: from `wordpress` and the setup Job.
- `notes-mcp`, `server-everything`: from the gateway only.
- `postgres`: from the gateway only.

W4 is demonstrated in two ways: there is no Ingress or NodePort for woo-mcp, and `kubectl run` a test pod in another namespace and `curl` woo-mcp, which times out, while the gateway's call succeeds. **To verify (stage 2):** enforcement on the pinned k3d/k3s version with that test.

### Is the gateway's MCP endpoint stateful?

The endpoint is stateless. Each POST carries the API key and is authorized on its own. There are no `Mcp-Session-Id` sessions for either protocol era.

The gateway process does hold state in memory: the upstream clients, the tool cache and status, and the notification bus for `subscriptions/listen`. With two replicas:

- Each replica would run its own refresh loop, so status could briefly differ between replicas and dashboard reads could flip.
- An admin action handled by replica A would publish `list_changed` only to listeners connected to replica A.
- Each replica would double the health traffic to upstreams.

Calls, listing, auth and audit would still be correct, because they read PostgreSQL and the cache rebuilds itself. The chart runs one replica. Fixing the above would mean storing status in PostgreSQL and fanning notifications out with `LISTEN/NOTIFY`; that is the scaling extension and out of scope.

## Request flows

External client `tools/call`:

1. Client POSTs to `https://app.<domain>/mcp` with `Authorization: Bearer urk_...`.
2. Gateway hashes the key and loads the member. Unknown or revoked key: HTTP 401, audit entry `rejected` with the key's display prefix and no member.
3. `authorizeToolCall`, then `routeToolCall` maps `store__list_orders` to the WooCommerce upstream and `list_orders`.
4. The registry's client for that upstream calls `list_orders` with the upstream's static credential, if any. The client's API key is not forwarded.
5. woo-mcp signs a REST request to WordPress, trims the response and returns it.
6. Gateway returns the result unchanged except for size limits, and writes the audit entry (`succeeded`, duration).

Chat: browser POSTs to `/api/chat` with the session cookie. The gateway runs the LLM loop and uses steps 3–6 for each tool call, as that member, with `via = chat`.

## Data model

```
members        id, email (unique), name, role (admin|member), password_hash, active, created_at
sessions       id_hash, member_id, expires_at
invites        token_hash, email, role, created_by, expires_at
api_keys       id, member_id, key_hash (unique), display_prefix, name, created_by, created_at, revoked_at, last_used_at
upstreams      id, prefix (unique), name, url, auth_type (none|bearer|header), auth_header_name, auth_secret, enabled, created_at, updated_at
audit_entries  id, at, member_id (nullable), key_prefix (nullable), via (mcp|chat), upstream_id (nullable), upstream_prefix, tool, duration_ms, outcome (succeeded|failed|timed_out|rejected), reason
```

`upstreams.auth_secret` is write-only through the API: responses say whether a credential is set, never what it is. Encrypting it at rest is a hardening extension. Audit entries copy `upstream_prefix` and `tool` as text so entries stay readable after an upstream is removed.

The WooCommerce upstream is inserted on the gateway's first start from chart values (name, prefix, URL of the woo-mcp Service) (G7). A one-row `bootstrap` table records that this happened, so an admin who later renames or removes it does not get it back on restart.

## Kubernetes topology

| Exposed publicly (Ingress) | Internal only (ClusterIP + NetworkPolicy) |
|---|---|
| `store.<domain>`: WordPress | woo-mcp, MariaDB |
| `app.<domain>`: gateway (dashboard, `/api`, `/mcp`) | PostgreSQL, notes-mcp, server-everything |

Every workload has requests and limits and readiness and liveness probes that check something real:

| Workload | Readiness | Liveness |
|---|---|---|
| MariaDB | `healthcheck.sh --connect --innodb_initialized` | `healthcheck.sh --connect` |
| WordPress | HTTP GET `/wp-login.php` | TCP 80 |
| woo-mcp | `/healthz`: process up and config loaded (does not call the store, so a store restart does not cycle woo-mcp) | same |
| gateway | `/readyz`: PostgreSQL query succeeds. Upstream health is not checked | `/healthz`: event loop responds |
| PostgreSQL | `pg_isready` | `pg_isready` |
| notes-mcp, server-everything | HTTP GET on their health or MCP path | TCP |

Containers run as non-root where the image allows it (all Node images, PostgreSQL, MariaDB). The official WordPress Apache image starts as root and drops to `www-data`; **To verify (stage 7):** whether it runs fully as non-root on port 8080 with a config change, otherwise document the exception.

Image tags are pinned in `values.yaml`. Gateway, woo-mcp and notes-mcp images are built locally and loaded with `k3d image import`; on the VPS they come from GHCR with a pinned tag.

## Requirement to mechanism

| Req | Mechanism |
|---|---|
| K1, K2, K3 | Two Helm charts; k3d locally, k3s on the VPS; differences only in `values-*.yaml` |
| K5 | PVCs for MariaDB, `wp-content`, PostgreSQL |
| K6 | Traefik Ingress, `*.localtest.me` locally |
| K7 | Probes and resources on every template |
| K8, G5 | Operator-created Secrets referenced by name; upstream credentials write-only in the API |
| W1, W2, W3 | `woo-mcp/`, SDK v2 Streamable HTTP, five tools |
| W4 | No Ingress, ClusterIP, NetworkPolicy from gateway only |
| W5 | REST v3 with OAuth 1.0a signing (this document) |
| G1, G7 | Upstream CRUD API and dashboard; WooCommerce seeded from values on first start |
| G2 | Aggregated `tools/list` from cache, map-based `tools/call` routing |
| G3 | `<prefix>__<tool>` with a per-upstream prefix, 48-character cap with hash suffix |
| G4 | Parallel refresh with per-upstream timeouts, 30 s call timeout, Unreachable tools hidden |
| G6 | WooCommerce, server-everything, notes-mcp |
| T1, T3 | `members.role`, invite links |
| T2 | `urk_` keys, SHA-256, revocation checked on every call |
| T4, D9 | `writeAuditEntry` in the single tool-call path, audit page in the dashboard |
| C1, C2, C3 | Claude Messages API loop in the gateway using the same path, tool calls streamed to the UI, key in a Secret |

## Production changes

`values-prod.yaml` changes only:

- Hostnames: real domain names with DNS A records pointing to the VPS.
- Ingress: same Traefik class; TLS with cert-manager and Let's Encrypt is an optional extension.
- Storage class: k3s `local-path` (the default on both k3d and k3s; set explicitly so the choice is visible).
- Images: GHCR repository and tag instead of locally imported images.
- Resources: somewhat higher limits for WordPress and MariaDB.
- Secrets: created with the same `kubectl` commands on the VPS, with new random values.

## Upgrade and rollback

- `helm upgrade --install <release> charts/<chart> -f values-<env>.yaml --atomic --timeout 10m`. `--atomic` rolls back automatically if new pods do not become ready.
- `helm rollback <release> <revision>` returns templates and image tags to an earlier revision.
- PVCs carry `helm.sh/resource-policy: keep`, so an uninstall or a bad upgrade does not delete data.
- Gateway migrations only add tables and columns (no renames or drops within a release), so the previous image still works against the migrated schema after a rollback.
- WordPress and WooCommerce versions are pinned. Upgrading WooCommerce is a values change; its own database migrations run in the setup Job. WooCommerce schema changes are not reversible by Helm, so take a MariaDB dump (`mariadb-dump` via `kubectl exec`, documented in the README) before changing that version.
