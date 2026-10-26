# Design

Status: approved on 2026-10-23 and implemented. Statements marked **Verified** were checked against docs, package contents or the running system, with the build stage named where it matters. Statements marked **To verify** still need a check outside the build sandbox. The charts were not deployed to a public VPS (see [Production changes](#production-changes)).

## Components

| Component | Runs as | Responsibility |
|---|---|---|
| MariaDB | StatefulSet, PVC, namespace `store` | Store database |
| WordPress + WooCommerce | Deployment (1 replica), PVC for `wp-content`, namespace `store` | Storefront and wp-admin |
| Store setup Job | Helm post-install/post-upgrade hook, namespace `store` | Installs WordPress, WooCommerce, COD and the REST key, idempotently |
| `woo-mcp` | Deployment, ClusterIP Service, namespace `store` | MCP server written here. Five tools over the WooCommerce REST API |
| `gateway` | Deployment (1 replica), namespace `gateway` | MCP endpoint for clients, MCP client to every upstream, auth, audit, chat agent, dashboard API, serves the built dashboard |
| PostgreSQL | StatefulSet, PVC, namespace `gateway` | Members, sessions, invites, API keys, upstreams, audit entries |
| `server-everything` | Deployment, ClusterIP Service, namespace `gateway` | Second upstream: the official MCP reference server |
| `notes-mcp` | Deployment, ClusterIP Service, namespace `gateway` | Third upstream, written here: a small notes server that requires a bearer token |
| Store provisioner | Deployment (1 replica, gateway image), namespace `gateway`, its own service account | Creates and deletes the stores members request on the Stores page: a namespace `store-<slug>` per store with the store chart installed, and its woo-mcp registered as an upstream |

The dashboard (`dashboard/`, React + Vite) is built into the gateway image and served by the gateway from the same origin as `/api` and `/mcp`. One origin means no CORS and one Ingress host.

Stack: TypeScript on Node 24 LTS, Express 5, the MCP TypeScript SDK v2 (`@modelcontextprotocol/server` and `@modelcontextprotocol/client` 2.4, plus `@modelcontextprotocol/node` to mount the handler in Express), `pg` with plain SQL migrations, the Claude TypeScript SDK (`@anthropic-ai/sdk` 1.2), React 19 and Vite for the dashboard, Vitest with PGlite standing in for PostgreSQL in tests, ESLint and Prettier. All versions are pinned.

**Verified:** SDK v2 is the current stable line and implements the 2026-07-28 spec. It also serves 2025-era clients (`initialize` handshake) statelessly by default (`createMcpHandler`, whose default for legacy clients is stateless). SDK v1 (`@modelcontextprotocol/sdk` 1.32.x) is the maintenance line and stops at 2025-11-25. Using v2 lets the gateway talk to both new and older clients and upstreams.

### Repository layout

```
charts/store/      MariaDB, WordPress, setup Job, woo-mcp
charts/gateway/    gateway, PostgreSQL, the two extra upstreams
woo-mcp/           WooCommerce MCP server
notes-mcp/         notes MCP server (third upstream)
everything/        image for the MCP reference server (second upstream)
gateway/           backend: MCP endpoint, upstream client, auth, audit, chat agent
dashboard/         React frontend
docs/              design.md, threat-model.md
```

`notes-mcp/` and `everything/` are additions to the layout in CLAUDE.md, needed for G6.

Two charts instead of one: the store chart is the unit that the provisioner installs once per store, and the gateway does not need to be reinstalled when a store changes. Each chart has `values.yaml`, `values-local.yaml` and `values-prod.yaml`.

## Decisions

### How woo-mcp talks to WooCommerce

| Option | For | Against |
|---|---|---|
| REST API (`/wp-json/wc/v3`) | Stable, versioned, documented; runs WooCommerce's validation, hooks and stock logic; needs only HTTP | Needs a credential and request signing over plain HTTP |
| WP-CLI | No HTTP auth | Needs the WordPress files and PHP in the MCP pod, or `kubectl exec` rights; slow per call |
| Direct database | Fast | Skips WooCommerce logic (stock, totals, order notes, HPOS tables); breaks on schema changes |

**Decision: REST API v3** over the in-cluster Service `http://wordpress.store.svc.cluster.local`.

WooCommerce accepts HTTP Basic auth with a consumer key and secret only over HTTPS. Over plain HTTP it requires OAuth 1.0a one-legged signing. Traffic between pods is plain HTTP, so woo-mcp signs each request with OAuth 1.0a (HMAC-SHA256, Node `crypto`, about 40 lines, unit-tested). The alternative, faking `is_ssl()` with a mu-plugin, changes WordPress behavior for every request and is harder to defend. **Verified (stage 2):** the signature matches the verification in WooCommerce 11.2.1's PHP code, and all five tools work against the running store.

Tools (W3), each with a JSON Schema for input and validation at the boundary:

| Tool | REST call |
|---|---|
| `list_products` | `GET /products` (search, status, page, per_page ≤ 50, default 20) |
| `create_product` | `POST /products` (name, regular_price, optional description, status defaults to `publish`) |
| `list_orders` | `GET /orders` (after, before, status, page, per_page ≤ 50) |
| `get_order` | `GET /orders/{id}` |
| `update_order_status` | `PUT /orders/{id}` with `status` from WooCommerce's fixed list |

`list_orders` takes local date-times (`2026-10-24T00:00:00`) and its description tells the model the store's timezone, so "orders that came in today" maps to an `after` value the model can compute; the chat agent also gives the model the current time. Results are trimmed to the fields a person needs (id, number, status, total, currency, date, customer name, payment method, line items), which keeps the LLM context small and leaves out customer addresses and emails. Store responses are validated against a schema, so a changed store API gives a clear error instead of a garbled result.

### First deploy: a working store without manual steps

| Option | For | Against |
|---|---|---|
| Helm hook Job using the `wordpress:cli` image | Plain WP-CLI commands, idempotent, no custom image | Downloads WooCommerce from wordpress.org at install time |
| Custom WordPress image with WooCommerce baked in | No download at install | One more image to build, push and patch |
| Manual setup in wp-admin | None | Violates "helm install produces a working store" |

**Decision: post-install and post-upgrade hook Job** that waits for the database, then runs:

1. `wp core install` if not installed (site URL from values, admin password from the Secret).
2. `wp plugin install woocommerce --version=<pinned>` if the installed version differs, then activate it and run its database update.
3. Store settings: timezone, pretty permalinks, the WooCommerce pages, currency, country, no "coming soon" mode, no shipping; enable the COD gateway (`wp wc payment_gateway update cod --enabled=true`).
4. Store the REST key from the Secret in `wp_woocommerce_api_keys` with `wp eval-file` (stored the way WooCommerce stores keys: `wc_api_hash(consumer_key)`, the secret, and the last 7 characters), inserting or updating the row the chart owns. Read/write permission, acting as the admin.
5. Create two sample products on the first run only.

Every step checks before acting, so the Job runs on every install and upgrade. **Verified (stage 1):** WordPress image `wordpress:7.1.3-php8.4-apache`, WP-CLI `wordpress:cli-2.12.0-php8.4`, WooCommerce 11.2.1; repeated upgrades rerun the Job cleanly. **Verified (2026-10-24, README setup on a Mac with k3d):** the Job downloaded WooCommerce 11.2.1 from wordpress.org and installed it.

The WordPress pod turns ready before the Job has run, because until WordPress is installed every page redirects to the web installer and the readiness probe accepts redirects. Whoever reached `/wp-admin/install.php` in that window could create the admin account. The shared wp-config extra therefore answers 403 to the web installer for every request that is not WP-CLI, so only the Job can install WordPress.

**How credentials reach woo-mcp:** the operator creates one Secret, `store-credentials`, before install (commands in the README, values from `openssl rand`): DB passwords, WordPress admin password, `WC_CONSUMER_KEY` (`ck_` + 40 hex) and `WC_CONSUMER_SECRET` (`cs_` + 40 hex). MariaDB, WordPress, the setup Job and woo-mcp all reference keys from that Secret through `secretKeyRef`. Because the key is generated before WooCommerce exists and inserted by the Job, no one has to copy a key out of wp-admin. Charts take the Secret name as a value and never contain secret values.

Why operator-created Secrets instead of Helm generating them with `randAlphaNum` and `lookup`: `lookup` returns nothing under `helm template` and `--dry-run`, so generated values change on every render unless guarded, and the credentials end up in Helm release history. Creating Secrets with `kubectl` is one documented command and works the same locally and on the VPS.

### Upstream connections and status

| Option | For | Against |
|---|---|---|
| One long-lived MCP client per enabled upstream | Tool list can be cached; status known before a client asks; reuses HTTP connections | Must reconnect after failures |
| New connection per client request | No state | Every `tools/list` fans out to every upstream, so a slow upstream slows every listing |

**Decision: one long-lived client per enabled upstream,** owned by an upstream registry in the gateway process.

- On start, and when an admin adds or enables an upstream or changes its URL or credential, the registry connects (SDK negotiates the protocol era) and lists tools. A name or slug change only recomputes the exposed names.
- Every 15 s a refresh loop re-reads the upstreams table and lists tools on every enabled upstream in parallel, each with a 5 s timeout (and 5 s to connect). Re-reading the table picks up an admin change handled by another gateway process, such as the old pod during a rolling update. Success sets **Connected** and replaces the cached tool list. Failure sets **Unreachable**, records the reason (timeout, connection refused, HTTP status, protocol error), and drops a broken client so the next refresh reconnects.
- A tool call that fails at the transport level marks that upstream Unreachable immediately, so the dashboard updates without waiting for the next refresh (D8). A call answered with an HTTP error status, such as 413 for an oversized request, fails on its own and triggers an immediate check instead, so one member's bad request cannot hide a healthy upstream's tools from everyone.
- **Disabled** comes from the database. A disabled upstream has no client and no tools.
- If an upstream advertises `tools.listChanged`, the registry also re-lists on that notification. When the upstream ends that stream on purpose, for example because its pod is shutting down, the next refresh opens a new stream on the same client, so calls still running on it are not cut off; an unexpected drop is checked at once.

### Tool-name namespacing

**Verified limits:**

- MCP spec 2026-07-28: names SHOULD be 1–128 characters from `A-Z a-z 0-9 _ - .`. The spec says aggregators SHOULD disambiguate, for example with a server prefix, and that `serverInfo.name` is not unique enough to use.
- Cursor: server config key plus tool name must be at most 60 characters, and dots are rejected (Cursor forum, staff replies).
- Claude API: tool names must match `^[a-zA-Z0-9_-]{1,128}$` (Anthropic tool-use docs). This applies to the chat agent and to Claude Code.
- Claude Code exposes MCP tools to the model as `mcp__<server>__<tool>` (**Verified** from the Claude Code MCP docs, which give that form for hook matchers). The README and the dashboard name the server `team-gateway`, which adds 19 characters, well inside 128.

Cursor's 60-character limit is the tightest of these. `team-gateway` is 12 characters, so 48-character tool names fit it exactly.

**Decision:** tools keep their upstream names. A prefix is added only when two enabled upstreams expose the same name.

- The exposed name is the upstream's tool name with any character outside `[A-Za-z0-9_-]` replaced by `_`. A server's `list_orders` reaches clients as `list_orders`.
- Each upstream has a `slug` (lowercase `[a-z0-9-]`, 2–16 characters, unique). It defaults to a slug of the name the admin types and can be edited. Nothing in the code fixes a slug, including for WooCommerce, whose name and slug come from gateway chart values.
- When two or more enabled upstreams expose the same name, every one of those colliding tools is renamed to `<slug>__<name>`, for example `store__search` and `notes__search`. Tools that do not collide keep their plain names. Renaming all sides, instead of letting the first-registered server keep the plain name, means the result does not depend on registration order, and the model is never handed one plain `search` that silently means one particular server.
- Collisions are computed over every enabled upstream using its last known tool list, including upstreams that are currently Unreachable. So a pod dying (D8) does not rename the other server's tools back and forth.
- Maximum exposed length is 48 characters. That leaves room for Cursor's 60 with a config key of up to 12 characters. A longer name is cut to 41 characters plus `_` plus the first 6 hex characters of the SHA-256 of the full name, so it stays unique and stable.
- Tools of a provisioned store's upstream are always `<slug>__<name>`, such as `delhi__list_orders`, even without a collision, because the multi-store bonus requires that a tool name says which store it acts on. This does not change the rule for other servers: Notes and Everything keep plain names. The original store is not a provisioned one, so its tools are plain until a provisioned store exists; then they collide with the store's base names and become `woocommerce__list_orders` under the rule above. With several stores, every store tool therefore names its store.
- Any duplicate left after these steps (for example an upstream tool literally named `notes__search`, or two names that sanitize to the same string) gets the same hash suffix. A name that is still ambiguous after that is left out, so a call can never reach the wrong upstream.

Tradeoff: plain names are what clients and the model see most of the time, and they read naturally in prompts and in the chat UI. The cost is that adding an upstream with an overlapping name renames the existing tool for every client. The gateway sends `list_changed` when that happens, and the dashboard shows which tools are renamed and why, so the admin sees the effect before and after adding a server. The alternative, prefixing every tool always, keeps names stable but puts a server name on every tool, which Kajal chose against.

Collisions are not part of the normal three-upstream setup. They are covered by unit tests and can be shown by registering notes-mcp a second time under another slug (README): all three notes tools become `<slug>__<tool>` on both entries, and the dashboard explains each rename.

**Mapping back:** the gateway never parses names to route. Each cache refresh builds a map from exposed name to `{upstreamId, originalName}`. `tools/call` looks the name up in that map, so the scheme can change without touching routing. The mapping function is pure and unit-tested (collisions, length, sanitizing, stability).

### How clients learn the tool list changed (D7)

The gateway's `tools/list` is served from the registry's in-memory state: the cached tools of enabled, connected upstreams. Every admin change re-reads the upstreams table into the registry before the API responds, so any client that lists again sees the change.

On top of that:

- **2026-07-28 clients** can open `subscriptions/listen` with `toolsListChanged`. When an upstream is enabled, disabled, removed, or its tool list changes, the gateway publishes `notifications/tools/list_changed` through the SDK handler's notification bus.
- **2025-era clients** are served statelessly, which means no standalone GET stream (**Verified:** the SDK returns 405 for legacy GET in this mode). They see the change on their next `tools/list`, for example a reconnect in Claude Code or "List Tools" in MCP Inspector.
- **Chat agent:** lists tools at the start of every turn, so a disabled upstream's tools are gone from the next message.

**Decision: both** push (for clients that subscribe) and per-request listing (for everyone). Keeping sessionful legacy support just for GET streams would make the gateway stateful for one feature. **Verified:** MCP Inspector CLI 2.12 speaks the 2025 protocol (`initialize`) and sees a disabled server's tools disappear on its next `tools/list` (stage 7 acceptance run); a 2026-era SDK client receives `list_changed` (gateway tests). **To verify:** which era Claude Code and Cursor speak, and whether they re-list on their own or need a reconnect.

### Timeouts, fan-out and caching

| Operation | Timeout | Why |
|---|---|---|
| Connect to an upstream | 5 s | A healthy in-cluster server answers in milliseconds |
| Upstream `tools/list` (refresh loop) | 5 s per upstream, all in parallel | A slow server costs its own timeout, not the whole refresh |
| Upstream `tools/call` | 30 s | Store writes can be slow; long enough for real work, short enough for an LLM loop |
| Client `tools/list` at the gateway | No upstream call | Served from cache, so a dead upstream cannot slow it |
| WooCommerce REST call inside woo-mcp | 20 s | Under the gateway's 30 s so woo-mcp can return a clear error first |

A timed-out call is cancelled (the SDK aborts the request) and returns an MCP tool error: `Upstream "Notes" did not respond within 30 s.` Unreachable upstreams return `Upstream "Notes" is unreachable: <reason>.`, with a reason as described under Observability. Neither message includes URLs or credentials. Upstream results over 1 MB are replaced by an error, and the chat agent passes Claude at most 50,000 characters of one result.

Cache invalidation: the per-upstream tool cache is replaced on every successful refresh, on admin edits to the URL or credential, and on upstream `list_changed`. It is dropped when the upstream is disabled or removed. Tools from an Unreachable upstream are hidden from `tools/list`, because listing tools that will fail wastes the model's turns.

### Human login and invites

**Decision:** email and password with a server-side session.

- Passwords hashed with `crypto.scrypt` (Node built-in, N=2^15, r=8, p=1), so no native dependency.
- Login sets an `HttpOnly`, `SameSite=Lax` cookie holding a random session id. Sessions live in PostgreSQL with a 7-day expiry and are deleted on logout.
- Every dashboard API request other than a GET must carry the header `X-Requested-With: urumi-dashboard`, which a cross-site form cannot send.
- The first admin is created at gateway start if no members exist, from `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` in the `gateway-credentials` Secret.

Invites without email: an admin enters an email and role, the gateway creates a one-time token (32 random bytes, stored as SHA-256, expires in 72 h) and shows a link `https://<dashboard>/invite#<token>` once. The token is in the URL fragment, which browsers never send to a server, so it stays out of access logs; the dashboard posts it in a request body. The admin sends the link any way they like. Opening it lets the invitee set a name and password. The token is deleted on use.

Alternatives considered: OAuth/OIDC login (needs an identity provider for a local demo; listed as a later extension), magic links (need email).

### API keys

Format: `urk_` followed by 32 bytes from `crypto.randomBytes`, base64url (43 characters). The first 8 characters after `urk_` are stored in clear as a display prefix so members can tell keys apart.

Storage: SHA-256 of the full key, with a unique index. Verification hashes the presented key and looks it up, then checks `revoked_at IS NULL` and that the member is active. There is no cache, so revocation applies on the next call (D6).

Why a fast hash: password hashes (scrypt, argon2) exist to slow down guessing of low-entropy secrets. A key with 256 bits of randomness cannot be guessed whatever the hash speed, so a slow hash would only add tens of milliseconds and CPU to every MCP request. SHA-256 also allows lookup by hash, so there is no per-key comparison loop and no timing signal on the secret.

Keys are shown once on creation. Members create and revoke their own keys. Admins can create a key for a member (shown once to the admin) and revoke any key. A call with a revoked key, or with a deactivated member's key, still matches a stored hash, so its rejection is audited under that member.

### Chat agent as the logged-in member

`callTool` in `gateway/src/toolCalls.ts` runs each step every tool call goes through:

1. `mayUseTools(member)`: the member is active and their role allows tool use.
2. `registry.resolve(exposedName)`: map lookup to the upstream and original name; unknown and disabled tools are rejected.
3. `registry.callTool(...)`: the upstream's credential, the timeout and error mapping.
4. `writeAuditEntry(...)`: always, in a `finally`, including rejections and unexpected errors.

The MCP endpoint resolves the member from the API key and calls this path. The chat endpoint (`POST /api/chat`) resolves the member from the session cookie and calls the same path with `via = chat`. There is no other code that calls upstreams.

LLM: the Claude API through the official TypeScript SDK (`@anthropic-ai/sdk` 1.2.0), model `claude-haiku-5-5` (a constant in `gateway/src/chat.ts`). Haiku 5.5 is the fast, low-cost Claude model, which suits short store questions and tool calls; a larger model would answer harder questions better at a higher cost per turn. The API key is the `ANTHROPIC_API_KEY` entry of the `llm-credentials` Secret (C3).

The chat loop is a manual loop over the Messages API rather than the SDK's tool runner, because every tool execution has to go through the gateway's own path and the loop is short enough to read in one screen:

1. List the gateway's tools once for the turn and convert each to a Claude tool (`name`, `description`, `input_schema`). Exposed names already match the Claude API's name rule. The list stays fixed for the turn, because changing tools mid-turn would invalidate the turn's thinking; a tool disabled meanwhile fails in `callTool` with a clear error.
2. Stream a Messages API request with the system prompt, the conversation, the tools and `effort: medium`. Haiku 5.5 uses adaptive thinking when the request has no thinking setting, so none is sent, and `tool_choice` is left at its default (`auto`). The request sets `cache_control` at the top level, which puts the cache breakpoint on the last block, so later rounds of a turn can read the earlier rounds' prefix from the cache. A new turn reads nothing from the cache: the history is resent as text only, and no breakpoint marks the system prompt and tools on their own. The current time goes in the last user message rather than the system prompt, so it does not change the prefix that later rounds read.
3. If `stop_reason` is `refusal` or `max_tokens`, stop and show a clear message; tools from a cut-off turn are not run.
4. Run every `tool_use` block in the response in parallel through the path above, then send all `tool_result` blocks back in one user message, with `is_error: true` for failed, timed-out or rejected calls.
5. Repeat until `stop_reason` is `end_turn`, at most 8 rounds.

Haiku 5.5 has no server-side refusal fallback, so the request uses no beta features, and a policy decline ends the turn with the message from step 3. A decline can come after some text has streamed; the browser then drops the text of that round, so the partial answer is not kept or sent back as the assistant's turn.

`POST /api/chat` streams newline-delimited JSON events to the browser: assistant text as it arrives, and each tool call (name, server, arguments) and its result (error flag and the first 2,000 characters) as it happens, so the UI shows which tools ran (C1). The conversation is kept in the browser and sent with each message as text only, so no thinking block from an earlier request is replayed; the gateway stores only audit entries. Earlier tool calls and results are therefore not resent, and the system prompt says so, because otherwise the model reads its earlier statements about a tool result as unsupported and takes them back. A follow-up that needs more than an earlier answer said calls the tool again. Resending earlier results as text in the assistant's turn was rejected, because it would present untrusted tool output as Claude's own words. Closing the page, or moving to another page of the dashboard, cancels the turn, including running tool calls. The system prompt tells the model that tool descriptions and results are data from third-party servers and never instructions, and that it changes things only when the member asked for the change.

**Verified (2026-10-25, on a Mac against the Claude API, first with `claude-opus-5-5` and again with `claude-haiku-5-5`):** asked to create a product, the agent called `create_product`, and the product appeared on the storefront. Asked which orders came in today, it called `list_orders` with today's store-local date. The UI showed each call, and the audit log recorded them under the signed-in member, marked chat (D2, D3, D9). In that Haiku run, before the system prompt mentioned the text-only history, the second answer took back the product's id and stock status from the first, although the tool had returned both. **To verify:** that the system prompt line stops this.

Alternative considered: the agent connects to the gateway's own `/mcp` with a key minted for the member. That proves the external path, but needs a hidden key per member and an HTTP hop for nothing. The shared function gives the same guarantee and is easier to test.

### Additional upstreams and the D5 prompt

| Option | For | Against |
|---|---|---|
| Hosted public MCP servers (for example a vendor's remote server) | Real third-party behavior | Need outside accounts and credentials, internet egress from the cluster, and break when the vendor changes; the demo cannot run offline |
| In-cluster servers: the official reference server plus a small server written here | Reproducible with `helm install`; the reference server has failure tools (sleep, errors); the in-repo server can require a bearer token | Less realistic data |

**Decision: in-cluster servers,** both installed by the gateway chart:

| Upstream | Where | Credential |
|---|---|---|
| WooCommerce (`woo-mcp`) | namespace `store`, pre-registered | none at the MCP layer; NetworkPolicy restricts callers |
| MCP reference server (`@modelcontextprotocol/server-everything` 2.0.0, Streamable HTTP mode on port 3001) | namespace `gateway`, added by an admin at `http://everything:3001/mcp` | none |
| `notes-mcp` (in repo): `save_note`, `list_notes`, `search_notes`, notes in memory | namespace `gateway`, added by an admin at `http://notes-mcp:3000/mcp` | bearer token from the `notes-credentials` Secret, entered by the admin in the dashboard (exercises G1 and G5) |

`server-everything` is useful for failure tests because it has tools that sleep and that return errors. **Verified (stage 3):** started with `node dist/index.js streamableHttp`, it serves 22 tools at `/mcp`, including `echo`, `get-sum` and `trigger-long-running-operation`.

D5 prompt: "Look up today's orders in the store and save a note called 'Orders today' that lists each order's number, customer and total." This needs `list_orders` from WooCommerce and `save_note` from notes-mcp.

### Gateway database

| Option | For | Against |
|---|---|---|
| PostgreSQL | Concurrent writes, works with more replicas later | One more StatefulSet |
| SQLite on a PVC | No extra workload | One writer; a second replica cannot share it |

**Decision: PostgreSQL** (official image, pinned tag), StatefulSet with a PVC in namespace `gateway`. Migrations are plain SQL files applied at gateway start inside a transaction with an advisory lock.

### Ingress and local domains

| Option | For | Against |
|---|---|---|
| Traefik | Ships with k3s and k3d, so nothing extra to install or pin | Its own annotations for anything beyond plain Ingress |
| ingress-nginx | Widely documented | One more chart to install and pin on both clusters, with k3s's Traefik disabled; Kubernetes announced its retirement (best-effort maintenance until March 2026) |

**Decision: Traefik,** so local and VPS use the same controller and the same Ingress objects.

Local hostnames: `store.localtest.me` and `app.localtest.me`. `localtest.me` and every subdomain resolve to 127.0.0.1 in public DNS, so browsers and CLI clients work without editing `/etc/hosts` (**Verified (2026-10-24)** on a Mac: both names resolve to 127.0.0.1 and ::1; the build sandbox has no outside DNS and used `/etc/hosts`). The k3d cluster maps host port 80 to its load balancer. Offline fallback, documented in the README: add both names to `/etc/hosts`.

`*.localhost` was rejected because some resolvers outside browsers do not resolve subdomains of `localhost`, which would break CLI MCP clients. `.local` was rejected because macOS sends it to mDNS.

WordPress `siteurl` is `http://store.localtest.me`. Inside the pod that name resolves to the pod itself, where Apache listens on 80, so WordPress loopback requests still work. woo-mcp calls the Service name instead.

`app.localtest.me` routes `/` (dashboard), `/api` and `/mcp` to the gateway. There is no Ingress for woo-mcp, notes-mcp, server-everything or either database.

### NetworkPolicies on the local cluster

| Option | Enforces NetworkPolicies | Against |
|---|---|---|
| k3d (k3s in Docker) | Yes: k3s embeds a network policy controller (kube-router) next to flannel | None for this project |
| Kind | kindnet implements NetworkPolicies through kube-network-policies, depending on the Kind release | A different distribution and Ingress setup from the VPS |
| Minikube | Only with a policy-enforcing CNI such as Calico | An extra CNI to install, which the VPS does not use |

**Decision: k3d,** because the local cluster then runs the same distribution as the VPS, and NetworkPolicies are enforced in both with the same objects.

Each chart has a default-deny ingress policy for its namespace, then allows (`charts/*/templates/networkpolicies.yaml`):

- `woo-mcp`: from pods labeled `app.kubernetes.io/name=gateway` in the namespace named by the store value `gatewayNamespace` (default `gateway`), on its port.
- `wordpress`: from the Ingress controller's namespace (`ingress.controllerNamespace`, `kube-system` for the Traefik that k3s ships) and from `woo-mcp`.
- `mariadb`: from `wordpress` and the setup Job.
- `gateway`: from the Ingress controller's namespace.
- `notes-mcp`, `server-everything`, `postgres`: from the gateway only.

Egress is not restricted: the gateway calls upstreams that admins add anywhere and the Claude API, and WordPress downloads plugins.

W4 is demonstrated in two ways: there is no Ingress or NodePort for woo-mcp, and a test pod in another namespace (or a pod in the gateway's namespace that is not the gateway) cannot connect to woo-mcp, while the gateway's calls succeed (README, "Check that woo-mcp is internal"). **Verified (stage 7)** on k3s v1.36.5: before the policies a pod in `default` reached every internal Service; after them it, a pod in `default` labeled `app.kubernetes.io/name=gateway`, and a non-gateway pod in `gateway` cannot connect to woo-mcp, WordPress, MariaDB, PostgreSQL, notes-mcp or server-everything (kube-router rejects the connection). The storefront, wp-admin, the setup Job and all three upstreams kept working.

### Is the gateway's MCP endpoint stateful?

The endpoint is stateless. Each POST carries the API key and is authorized on its own. There are no `Mcp-Session-Id` sessions for either protocol era.

The gateway process does hold state in memory: the upstream clients, the tool cache and status, and the notification bus for `subscriptions/listen`. With two replicas:

- Each replica would run its own refresh loop, so status could briefly differ between replicas and dashboard reads could flip.
- An admin action handled by replica A would publish `list_changed` only to listeners connected to replica A.
- Each replica would double the health traffic to upstreams.
- Each replica applies an admin change at once only when it handles the change itself. The other picks it up on its next refresh, up to 15 s later, and until then keeps listing and calling the old set, so D7 would be up to 15 s late on that replica.

Auth and audit would still be correct, because they read and write PostgreSQL on every request. The chart runs one replica; during a rolling update the old and new pods overlap for a few seconds, which the periodic re-read covers. Fixing the above would mean `LISTEN/NOTIFY` for admin changes and storing status in PostgreSQL; that is the scaling extension and out of scope.

### Server-side request forgery guard

An admin's upstream URL becomes a request from inside the cluster. Without a guard, the URL `http://169.254.169.254/` reads cloud credentials on a VPS, and `https://kubernetes.default.svc` or `http://postgres:5432` probe services that trust the cluster network.

Options considered: an allow list of URLs (safest, but every new server needs a chart change), checking the URL only when it is saved (defeated by DNS rebinding: the name resolves to a public address at save time and to an internal one later), and a check on the address of every connection.

**Decision: address checks on every connection, plus a check on save for a clear error.**

- Always refused, for every host: `0.0.0.0/8`, `127.0.0.0/8`, `169.254.0.0/16` (link-local, which includes the AWS, GCP and Azure metadata endpoint), Alibaba's `100.100.100.200`, multicast and reserved IPv4, `::`/`::1`, `fe80::/10`, AWS's IPv6 metadata `fd00:ec2::254` and IPv6 multicast. IPv4-mapped IPv6 addresses are checked as IPv4.
- Refused unless the host name is on the internal list: private and cluster-internal ranges, `10.0.0.0/8` (which holds k3s's pod and Service ranges), `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10` and `fc00::/7`. The chart builds the list from what it knows: the seeded store's host, `notes-mcp` and `everything` under every name their Services answer to (short name to `.svc.cluster.local`), `woo-mcp.store-*.svc.cluster.local` for provisioned stores, plus `upstreamNetwork.internalHosts`. A `*` matches part of one DNS label. The Kubernetes API, PostgreSQL and the provisioner are not on it.
- On every connection: the registry's MCP clients use undici's fetch with an Agent whose DNS lookup checks every address a host resolves to, and refuses the connection if any is blocked. An IP address in the URL is checked before the request. The Node fetch bundled with the runtime is not used for upstreams, so the guard does not depend on which undici version Node ships.
- On save: `POST` and `PATCH /api/upstreams` resolve the host and answer 400 `This URL cannot be used: ...` for a refused address. A host that does not resolve is accepted, as before, and shows as Unreachable.
- A refused connection shows as Unreachable with `blocked by the gateway's network policy: ...`.
- Redirects were already refused (`redirect: 'error'`), so a public server cannot bounce the gateway to an internal address.

Tradeoff: an upstream on a private network, such as another team's MCP server on the VPS provider's internal network, needs its host added to `upstreamNetwork.internalHosts` before it can be registered.

### Tool permissions

Options considered: per-member allow lists, per-role rules, or scopes on API keys. The brief's example (members read orders, only admins create products or change order status) is a rule about roles, and the team has two roles, so a rule per role covers it without a policy language.

**Decision:** an admin can make a whole server, or single tools of a server, **admins only**. Admins keep every tool; members neither see nor call admin-only ones.

- Storage: `upstreams.admin_only` and a table `admin_only_tools (upstream_id, tool)`, where `tool` is the tool's name on its upstream, so the rule survives a gateway-side rename (a collision prefix, a slug change). Deleting the server deletes its rules. Nothing is admin-only by default, so existing setups and D1 to D9 behave as before.
- One check, `mayCallTool(member, tool, restrictions)` in `permissions.ts`, pure and unit-tested. Listing goes through `toolsFor`, which filters the registry's tools with it, and both `tools/list` and the chat agent list through `toolsFor`. A call goes through the same check in the single call path after the name is routed, so a member who calls a hidden tool by name gets `Only admins may call this tool.`, and the call is audited as rejected with the server and tool.
- The rules are read from PostgreSQL on every listing and call, one small query each, so a change applies to the next request on every replica, with no cache to invalidate.
- A change sends `notifications/tools/list_changed`, so listening clients list again.
- The Servers page has an "Admins only" switch per server and per tool for admins. Members do not see admin-only servers at all, and only their own tools on the others.
- Store servers can be restricted too. A rule names one upstream, so restricting `create_product` on the original store does not restrict it on a provisioned store.

Not done: per-member rules, and restrictions on tool arguments (for example "members may only set orders to completed").

### Observability

Three views, each for a different reader:

- **Why an upstream is unreachable.** The registry walks the error's cause chain and reports the first specific reason: DNS lookup failed, connection refused, connection reset, connect timeout, host unreachable, TLS handshake failed (with the OpenSSL code), not an MCP server (wrong content type), redirect (the gateway does not follow redirects, so a credential cannot leave for another host), HTTP status, credential rejected (401/403), timed out, or an MCP protocol error. The reason is shown on the Servers page, logged in `upstream_status`, and appended to the error a client or the model gets for a call to that upstream (`Upstream "Notes" is unreachable: connection refused (nothing is listening on that port).`). Reasons never contain host names, URLs or credentials.
- **Per-server numbers for admins.** The Servers page shows, for each server, calls in the last 24 hours, the error rate (failed and timed-out calls over calls that reached the server), how many timed out, p50 and p95 latency, and how many were rejected. They are computed from `audit_entries` with `percentile_cont`, so they cover every replica and survive restarts, and need no metrics stack. An index on `(upstream_id, at)` keeps the query to one day of rows. Members do not get them, as they do not get other members' audit entries.
- **Prometheus metrics for operators.** Each gateway pod serves `/metrics` on port 9464: `gateway_tool_calls_total{upstream,outcome,via}`, `gateway_tool_call_duration_seconds{upstream}` (a histogram with buckets up to the 30 s call timeout), `gateway_upstream_up{upstream}`, and Node's process metrics. The label is the upstream's slug, so cardinality stays at one series set per server. The port is not in the Service, so the Ingress cannot reach it, and the NetworkPolicy admits it only from `metrics.scrapeNamespace` when that is set. The pod carries the usual `prometheus.io/scrape` annotations. No Prometheus is installed by the charts; `kubectl port-forward` shows the endpoint.

The audit log stays the record of each call. Metrics are counts per process, and reset when a pod restarts, which Prometheus handles for counters.

### Multi-store provisioning

The bonus: members create and delete stores from the dashboard. Each store is provisioned in its own namespace, with its own database, Secrets, volumes and Ingress host, and its own woo-mcp registered in the gateway without manual steps.

Options considered for who runs Helm:

- The gateway calls Helm or the Kubernetes API itself. Simplest, but the internet-facing process would then hold rights to create namespaces, Secrets and workloads.
- A custom resource and an operator that reconciles it. The most Kubernetes-native shape, but it needs a CRD, a controller framework and a second source of truth next to PostgreSQL, where ownership, limits and the dashboard's state already live.
- **Decision:** a separate provisioner Deployment in the `gateway` namespace, built from the gateway image (which also contains `helm` 4.3.1 and `charts/store`). The gateway only writes rows to a `stores` table. The provisioner reads the table every 5 seconds and carries out the rows in the `provisioning` and `deleting` states. The gateway keeps no Kubernetes rights and mounts no token; the provisioner has no Ingress and no route from outside.

Creating a store (`POST /api/stores` with a name):

1. The gateway derives a slug from the name (a DNS label of 2 to 16 characters), checks that no store or server uses it, checks the member's limit (`stores.maxPerMember`, default 3, counted under a row lock on the member so two requests cannot both pass) and inserts the row as `provisioning`, with URL `http://store-<slug>.<stores.domain>`. Sending the same name again returns the member's existing store with 200 instead of a second one, so a client can retry a request whose response it lost.
2. The provisioner creates the namespace `store-<slug>` with the labels `app.kubernetes.io/managed-by: urumi-provisioner` and `urumi.dev/store-id: <id>`, a RoleBinding there that grants it the store role, and the Secret `store-credentials` with freshly generated values (`crypto.randomBytes`), the same keys an operator creates for the original store.
3. It runs `helm upgrade --install store charts/store -n store-<slug> --values <shared values> --values - --wait=watcher --timeout <time left>`. The shared values come from `stores.chartValues` in the gateway chart (for example the woo-mcp image); the per-store values (URL, title, the gateway's namespace) go through stdin, so a store name needs no escaping. Helm waits for the workloads and the setup Job, which installs WordPress and WooCommerce as for the original store.
4. When Helm succeeds, one transaction marks the store `ready` and inserts its upstream (`http://woo-mcp.store-<slug>.svc.cluster.local:3000/mcp`, `upstreams.store_id` set). The gateway's 15-second reload connects it, lists its tools and sends `list_changed`.

Several stores provision at once, up to 4 Helm installs in parallel; more wait for a slot.

Deleting a store: the gateway marks the row `deleting` and deletes its upstream in the same transaction, then reloads the registry, so the store's tools are gone from clients before anything in Kubernetes changes. The provisioner cancels an install still running for that store (the Helm process is killed), deletes the namespace with foreground propagation, and removes the row once the namespace is gone. Deleting the namespace removes the release, the Secrets and the claims, and `local-path` then deletes the volumes. A namespace without the store's id label is never deleted: the row is removed and the namespace left alone. A store's upstream cannot be edited or removed on the Servers page (409), only enabled or disabled; it goes with its store.

Guardrails:

- The store chart has a ResourceQuota (requests 1 CPU and 1.5 GiB, limits 5 CPU and 3 GiB, 8 pods, 3 claims, 6 GiB of storage, no LoadBalancer or NodePort Services) sized for every pod at once plus a second woo-mcp pod during a rolling update, and a LimitRange with defaults and a per-container maximum of 1 CPU and 1 GiB. Both apply to the original store too.
- At most `stores.maxPerMember` stores per member (3).
- A provisioning timeout, `stores.provisionTimeoutMinutes` (15). It counts from when the attempt started (`stores.attempt_started_at`), so a provisioner restart does not reset it, and Helm's own `--timeout` is the time left. A store past it is marked `failed` with "Provisioning did not finish within 15 minutes."

Recovery: every step is safe to repeat, and each pass starts from what PostgreSQL and the cluster say, so a provisioner that restarts mid-store resumes it on its first pass. The namespace, RoleBinding and Secret are created only if missing (an existing Secret is kept, so the store's database password still matches its volume). A release that is not `deployed` (`pending-install` after a killed Helm, or `failed` from an earlier attempt) blocks `upgrade --install`, so it is uninstalled first; that keeps the namespace, the Secret and the claims. A release that is `deployed` finished before the restart, so the store is only registered. A Helm failure fails the store with Helm's first error line ("The store chart failed to install: ..."); a Kubernetes API or database error is retried on the next pass until the timeout. **Retry** on a failed store starts a new attempt (`attempt + 1`, new start time). Every write of a result checks the attempt number, so an old attempt cannot overwrite a newer state. The Deployment uses the `Recreate` strategy, so two provisioners never run Helm on one store at once.

Permissions: the provisioner's ClusterRole lets it get, create and delete namespaces, create RoleBindings, and `bind` one ClusterRole, `<gateway-namespace>-store`, which holds what Helm needs for the store chart (ConfigMaps, Secrets, Services, claims, quotas, Deployments, StatefulSets, Jobs, Ingresses, NetworkPolicies, and read access to Pods, ReplicaSets and events). It holds the store role only through the RoleBinding it creates in each store namespace, so it has no rights in existing namespaces and cannot read their Secrets. A ValidatingAdmissionPolicy denies any create, update or delete by the provisioner's account unless the target namespace carries the managed-by label (for a namespace itself: as created, or as it was before a delete), so it cannot create a RoleBinding in `kube-system` or delete a namespace it did not create.

Isolation: the store chart's NetworkPolicies already admit MariaDB connections only from the same namespace's WordPress and setup Job, and WordPress connections only from the Ingress controller and the same namespace's woo-mcp. An egress policy now limits woo-mcp to its own WordPress and DNS, so one store's MCP server cannot reach another store's database or WordPress, the gateway's database, or the internet. WordPress and the setup Job keep open egress, because they download WooCommerce.

**Verified (multi-store, k3s 1.36.5 test cluster, Helm 4.3.1):** two stores created at the same time both reached Ready, after the provisioner pod was deleted while both Helm installs were running (one release was left `pending-install`, the other `failed`; both were uninstalled and installed again, and the Secrets kept); their tools were listed as `delhi__*` and `pune__*`, with the original store's tools renamed `woocommerce__*`; each storefront answered on its own Ingress host. From Delhi's woo-mcp, Delhi's WordPress was reachable and Pune's WordPress and MariaDB, the original store, PostgreSQL, the gateway, Traefik and an internet address were refused; Pune's WordPress could not reach Delhi's MariaDB, WordPress or woo-mcp, and the provisioner could not reach woo-mcp. Deleting Delhi removed its upstream in the same request and its namespace and both volumes within 20 seconds. With a 1-minute timeout and a missing woo-mcp image, a store failed with the timeout reason after 60 seconds, and Retry brought it to Ready. A fourth store for one member was refused. The provisioner's account was refused a Secret in `kube-system`, deleting the `store` namespace, creating an unlabelled namespace and listing Secrets in `kube-system` and `store`. The test cluster cannot download WooCommerce (wordpress.org is blocked there), so these runs used a copy of the setup script without the WooCommerce steps.

**Verified (multi-store, Kajal's Mac, k3d with k3s 1.36.5, real setup Job and Claude API):** after `helm upgrade` of both releases to gateway image 0.2.0, Delhi and Pune were created at the same time and were both Ready about 45 seconds later, each with WooCommerce installed by its setup Job, its own volumes and Ingress host. The gateway listed `delhi__*`, `pune__*` and `woocommerce__*`. The README isolation check from Delhi's woo-mcp reached Delhi's WordPress and was refused by Pune's WordPress and MariaDB. Asked to compare today's orders in both stores, the chat agent called `delhi__list_orders` and `pune__list_orders`, and both calls were audited under the member with `via = chat`. Deleting Pune removed its upstream at once, and its namespace and both volumes within about 15 seconds.

## Request flows

External client `tools/call`:

1. Client POSTs to `https://app.<domain>/mcp` with `Authorization: Bearer urk_...`.
2. Gateway hashes the key and loads the member. Missing, unknown or revoked key, or a deactivated member's key: HTTP 401 and an audit entry `rejected` with the key's display prefix. A revoked key or a deactivated member's key matches a stored hash, so the entry is attributed to that member; an unknown key has no member.
3. `callTool` (`gateway/src/toolCalls.ts`) checks `mayUseTools(member)`, then `registry.resolve` maps `list_orders` to the WooCommerce upstream and its original tool name.
4. The registry's client for that upstream calls `list_orders` with the upstream's static credential, if any. The client's API key is not forwarded.
5. woo-mcp signs a REST request to WordPress, trims the response and returns it.
6. Gateway returns the upstream's content, structured content and error flag (the result's own `_meta` is dropped), refusing results over 1 MB, and writes the audit entry (`succeeded`, duration).

Chat: browser POSTs to `/api/chat` with the session cookie. The gateway runs the LLM loop and uses steps 3–6 for each tool call, as that member, with `via = chat`.

## Data model

```
members        id, email (unique), name, role (admin|member), password_hash, active, created_at
sessions       id_hash, member_id, expires_at
invites        id, token_hash (unique), email, role, created_by, expires_at
api_keys       id, member_id, key_hash (unique), display_prefix, name, created_by, created_at, revoked_at, last_used_at
upstreams      id, slug (unique), name, url, auth_type (none|bearer|header), auth_header_name, auth_secret, enabled, admin_only, store_id (nullable, unique, deleted with its store), created_at, updated_at
admin_only_tools  upstream_id (deleted with its upstream), tool (the upstream's tool name)
stores         id, slug (unique, DNS label), name, url, owner_id, status (provisioning|ready|failed|deleting), reason, attempt, attempt_started_at, created_at, updated_at
bootstrap      action, done_at
audit_entries  id, at, member_id (nullable), key_prefix (nullable), via (mcp|chat), upstream_id (nullable, no foreign key), upstream_name, tool, duration_ms, outcome (succeeded|failed|timed_out|rejected), reason
```

`upstreams.auth_secret` is write-only through the API: responses say whether a credential is set, never what it is. Encrypting it at rest is a hardening extension. Audit entries copy `upstream_name` and the original `tool` name as text so entries stay readable after an upstream is removed. `upstream_id` has no foreign key, so a call that finishes while its upstream is being removed is still audited.

The WooCommerce upstream is inserted on the gateway's first start from chart values (name, slug, URL of the woo-mcp Service) (G7). A one-row `bootstrap` table records that this happened, so an admin who later renames or removes it does not get it back on restart.

## Kubernetes topology

| Exposed publicly (Ingress) | Internal only (ClusterIP + NetworkPolicy) |
|---|---|
| `store.<domain>`: WordPress | woo-mcp, MariaDB |
| `app.<domain>`: gateway (dashboard, `/api`, `/mcp`) | PostgreSQL, notes-mcp, server-everything, the store provisioner (no Service) |
| `store-<slug>.<domain>`: WordPress of each provisioned store | its woo-mcp and MariaDB |

Every long-running workload has requests and limits and readiness and liveness probes that check something real (the setup Job has requests and limits instead of probes, and is bounded by `backoffLimit: 2` and `activeDeadlineSeconds: 900`):

| Workload | Readiness | Liveness |
|---|---|---|
| MariaDB | `healthcheck.sh --connect --innodb_initialized` | `healthcheck.sh --connect` |
| WordPress | HTTP GET `/wp-login.php` | TCP 80 |
| woo-mcp | `/healthz`: process up and config loaded (does not call the store, so a store restart does not cycle woo-mcp) | same |
| gateway | `/readyz`: PostgreSQL query succeeds. Upstream health is not checked | `/healthz`: event loop responds |
| PostgreSQL | `pg_isready` | `pg_isready` |
| notes-mcp | `/healthz` | same |
| server-everything | TCP 3001 (it has no health route, and `GET /mcp` without a session is a 400) | same |
| store provisioner | `/healthz`: a pass over the stores table finished in the last 60 s (database reachable, loop not stuck) | same |

Every long-running container runs as a non-root user with all capabilities dropped and privilege escalation off (**Verified (stage 7)** from `/proc/1/status` in each pod: uid 33 WordPress, 999 MariaDB, 70 PostgreSQL, 1000 for the Node images, no effective capabilities). WordPress runs Apache as `www-data` on port 80; the pod sets the namespaced sysctl `net.ipv4.ip_unprivileged_port_start=0` so no root or `NET_BIND_SERVICE` is needed. The one exception is a short init container in the WordPress pod and the setup Job that runs as root with only `CHOWN`, to hand the freshly created volume roots to `www-data`: `local-path` volumes ignore `fsGroup`.

Image tags are pinned in `values.yaml`. The gateway, woo-mcp, notes-mcp and everything images are built locally and loaded with `k3d image import`; on the VPS they come from GHCR with the same tags.

## Requirement to mechanism

| Req | Mechanism |
|---|---|
| K1, K2, K3 | Two Helm charts; k3d locally, k3s on the VPS; differences only in `values-*.yaml` |
| K4 | WordPress, MariaDB, the setup Job, woo-mcp, the gateway (with the dashboard), PostgreSQL, notes-mcp and server-everything all run as workloads of the two charts |
| K5 | PVCs for MariaDB, `wp-content`, PostgreSQL |
| K6 | Traefik Ingress, `*.localtest.me` locally |
| K7 | Probes and resources on every long-running workload; resources and a deadline on the setup Job |
| K8, G5 | Operator-created Secrets referenced by name; upstream credentials write-only in the API |
| W1, W2, W3 | `woo-mcp/`, SDK v2 Streamable HTTP, five tools |
| W4 | No Ingress, ClusterIP, NetworkPolicy from gateway only |
| W5 | REST v3 with OAuth 1.0a signing (this document) |
| G1, G7 | Upstream CRUD API and dashboard; WooCommerce seeded from values on first start |
| G2 | Aggregated `tools/list` from cache, map-based `tools/call` routing |
| G3 | Plain tool names; `<slug>__<tool>` only for colliding names, 48-character cap with hash suffix |
| G4 | Parallel refresh with per-upstream timeouts, 30 s call timeout, Unreachable tools hidden |
| G6 | WooCommerce, server-everything, notes-mcp |
| T1, T3 | `members.role`, invite links |
| T2 | `urk_` keys, SHA-256, revocation checked on every call |
| T4, D9 | `writeAuditEntry` in the single tool-call path, audit page in the dashboard |
| C1, C2, C3 | Claude Messages API loop in the gateway using the same path, tool calls streamed to the UI, key in a Secret |
| SSRF guard | Address checks in the upstream clients' DNS lookup on every connection and on save; internal host list from the chart |
| Tool permissions | `upstreams.admin_only` and `admin_only_tools`; `mayCallTool` in listing (`toolsFor`) and in the single call path |
| Observability | Failure reasons from the error cause chain; per-server stats from `audit_entries`; Prometheus `/metrics` on port 9464 |
| Multi-store bonus | `stores` table and Stores page; provisioner running Helm per namespace `store-<slug>`; RBAC bound per store namespace plus an admission policy; quota, LimitRange, per-member limit and timeout; woo-mcp egress policy; store tools always `<slug>__<tool>` |

## Production changes

`values-prod.yaml` in each chart changes only:

- Hostnames: `store.url` and `publicUrl`, real names whose DNS A records point to the VPS (`sslip.io` names work without a domain), and `stores.domain`, under which provisioned stores are served as `store-<slug>.<domain>`, which needs a wildcard record. They are empty in the file, because no VPS was set up, and the charts refuse to render without them.
- Ingress: same Traefik class; TLS with cert-manager and Let's Encrypt is an optional extension.
- Storage class: k3s `local-path` (the default on both k3d and k3s; set explicitly so the choice is visible).
- Images: public GHCR packages (`ghcr.io/kajal-jotwani/...`, same tags) instead of locally imported images, so the charts need no image pull secret. Provisioned stores get the GHCR woo-mcp image and the prod resource limits through `stores.chartValues`.
- Resources: higher memory limits for WordPress and MariaDB (1 GiB each) and a higher MariaDB memory request (384 MiB).
- Secrets: created with the same `kubectl` commands on the VPS, with new random values.

**Verified (stage 8)** on the test k3s with a fresh install of both charts from `values-prod.yaml` in new namespaces (hostnames and the namespace wiring set with `--set`, images loaded under their GHCR names): the setup Job completed, all three upstreams connected, and the two-user acceptance run D1 to D9 passed, with a stand-in for the Claude API. The charts were not deployed to a public VPS: the GHCR push, DNS records, firewall and SSH tunnel steps in the README have not been run.

## Upgrade and rollback

- `helm upgrade --install <release> charts/<chart> -f charts/<chart>/values-<env>.yaml --rollback-on-failure --timeout 10m` (Helm 4; Helm 3 calls the flag `--atomic`). It rolls back automatically if new pods do not become ready. **Verified (stage 8):** an upgrade to a gateway image tag that does not exist failed after the timeout and Helm rolled back to the previous revision; the old pod kept serving throughout.
- `helm rollback <release> <revision>` returns templates and image tags to an earlier revision.
- Each component rolls out on its own: woo-mcp and the gateway with a rolling update (the new pod is ready before the old one stops), WordPress with `Recreate` because `wp-content` is ReadWriteOnce, so the storefront is down for about 30 s. The README has a table per component. When one release changes both charts, the store goes first, so the gateway never calls a tool the running woo-mcp lacks.
- The provisioner installs a provisioned store once. It does not upgrade existing stores when the gateway image brings a newer store chart, because an upgrade that fails in a member's store should be an operator's decision, not a side effect of a gateway rollout. Each store is upgraded and rolled back with Helm in its own namespace, with `--reuse-values` to keep the values the provisioner gave it.
- Data survives an uninstall or a bad upgrade: the `wp-content` claim carries `helm.sh/resource-policy: keep`, and the MariaDB and PostgreSQL claims come from StatefulSet claim templates, which Helm does not delete.
- Gateway migrations (`gateway/migrations/*.sql`) run at start in one transaction under an advisory lock. They may only add tables and columns or drop foreign keys (no renames or other drops within a release), so the previous image still works against the migrated schema after a rollback.
- WordPress and WooCommerce versions are pinned. Upgrading WooCommerce is a values change; its own database migrations run in the setup Job. WooCommerce schema changes are not reversible by Helm, so take a MariaDB dump (`mariadb-dump` via `kubectl exec`, documented in the README) before changing that version. `helm rollback` does not undo the change either: the setup Job is a post-install and post-upgrade hook, so it does not run on rollback. Going back means an upgrade with the previous version, then a restore of the dump (README).
