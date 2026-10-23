# CLAUDE.md

Guidance for working in this repository.

## Project

A WooCommerce hosting platform with a team MCP gateway, running on Kubernetes. Admins register MCP servers once in a dashboard. Each team member then uses all of them through a single MCP endpoint with a personal API key, and through a chat agent in the dashboard. A WooCommerce store is the first data source.

Components:

1. **Store**: WordPress + WooCommerce and its database.
2. **WooCommerce MCP server**: written in this repo. Exposes products and orders as MCP tools. Internal to the cluster.
3. **Gateway + dashboard**: React dashboard and backend. The backend is an MCP client to every registered upstream server and an MCP server that exposes all of their tools at one endpoint.
4. **Chat agent**: an LLM tool loop in the dashboard that calls tools through the gateway.

Expected layout (finalized in `docs/design.md`):

```
charts/       Helm charts and values files
woo-mcp/      WooCommerce MCP server
gateway/      backend: gateway, auth, audit, chat agent
dashboard/    React frontend
docs/         design.md, threat-model.md
README.md
```

## Workflow

When rules conflict, the order is: correctness, verification, minimal change, clarity, maintainability.

### Design before code

No implementation until `docs/design.md` exists and has been approved. The questions it must answer are listed under [Design document](#design-document).

### Build order

Before each stage, state the plan in a few lines (files involved, how it will be verified) and wait for approval. Within an approved stage, proceed without asking about each file. A stage is complete only when its check passes.

1. **Store on a local cluster.** `helm lint` and `helm template` are clean. Storefront and wp-admin are reachable through Ingress. Checkout with COD works and the order shows in admin. Data survives a pod restart.
2. **WooCommerce MCP server.** All five tools are listed and callable from MCP Inspector over a port-forward. There is no route to it from outside the cluster.
3. **Gateway core.** Tools from three upstreams are aggregated, calls route correctly, name collisions are handled, and slow and dead upstream cases are tested.
4. **Users, roles, API keys, audit.** A revoked key is rejected on the next call. Every call, including rejected ones, is audited.
5. **Dashboard.** Servers (status, tools, add/edit/disable/remove), members and invites, keys, audit log.
6. **Chat agent.** Tool calls are shown in the UI and audited under the logged-in user.
7. **Hardening.** NetworkPolicies and non-root containers in place. Full acceptance run with two users passes.
8. **VPS.** The same charts deploy on k3s with `values-prod.yaml` and the acceptance run passes there.
9. **Docs.** README, design and threat model are accurate and complete.

Optional extensions (multi-store provisioning, tool permissions, OAuth, scaling and similar) are out of scope until the acceptance criteria pass and the work is explicitly requested.

### Correctness

- Never assume a file, function, dependency, schema, CLI flag, Helm value or API endpoint exists. Read the code or check the docs first.
- The MCP spec, MCP SDKs, the WooCommerce REST API and chart values change between versions. Check the docs for the version in use instead of relying on memory.
- Read a file before editing it.
- Keep what was observed separate from what is assumed, and label assumptions.
- A change is done when it has been verified: run it and show the relevant output. If it can't be run, say exactly what is unverified and give the command to run.
- No stubs or placeholders presented as finished, and no TODOs that hide required behavior.
- If blocked, stop and say what is missing and what has already been verified.
- Destructive operations (deleting PVCs or namespaces, dropping data, `helm uninstall` with live data) need explicit approval first.

### Scope

- Change only what the task needs. Preserve unrelated behavior and interfaces (API routes, function signatures, Helm value names). If a task requires changing an interface, say so.
- No drive-by refactors or formatting churn. Mention adjacent problems instead of fixing them unasked.
- Remove dead code your change creates. Leave unrelated code, TODOs and comments alone.
- Prefer the simplest correct solution. No speculative abstractions or configurability nobody asked for.
- New dependencies need a reason. Prefer well-maintained libraries and pin versions.
- Ask only when the answer changes correctness or design. Otherwise take the conventional option, state it, and continue. For significant choices with several valid options, give the options, the tradeoff and a recommendation, then wait.

### Reporting

After each change, give a short summary in chat: what changed, why this approach, how it was verified (commands and relevant output), and anything assumed or left open. This goes in the conversation, not in files.

### Progress notes

Keep the current stage, open issues and next step in `.claude/progress.md`. Add that path to `.git/info/exclude` so it is never committed. Read it at the start of each session.

## Git

- Commit each verified, logical change.
- **Never push.** Never open pull requests or create tags or releases. The maintainer reviews and pushes.
- Never force-push, rewrite history, change remotes, or create branches unless asked.
- Run `git status` and review the diff before committing. Stage files explicitly. Never commit secrets, `.env` files, kubeconfigs or build output.
- Commit messages: an imperative subject under 72 characters (`Add timeout to upstream tool calls`), with an optional body explaining why. Plain text only: no emoji, no co-author trailers, no tool signatures.

## Repository hygiene

The repo should stay small and easy to navigate.

- Documentation lives in exactly three files: `README.md`, `docs/design.md` and `docs/threat-model.md`. Don't add other markdown files.
- Prefer fewer, cohesive files. Split a module only when it has a genuinely separate responsibility. No index files that only re-export, and no `utils` or `helpers` grab-bags.
- No Makefiles, helper scripts, docker-compose files, CI config or devcontainers unless asked. Put commands in the README.
- Helm values: `values.yaml` for defaults, plus `values-local.yaml` and `values-prod.yaml`. Nothing else.
- Delete any scratch or temporary files you create. Don't commit generated files.

## Code style

Write the way an experienced engineer on a small team would: direct, consistent, no ceremony.

- Each function does one thing, and its name says what. If an accurate name needs "and", split the function.
- Use the domain vocabulary consistently: upstream, tool, API key, audit entry, member. Avoid vague names such as `data`, `result`, `handleRequest`, `processItem` or `Manager`.
- Keep pure logic (tool-name mapping, routing, permission checks) separate from I/O, so it can be tested without a cluster.
- Keep exactly one implementation each of config loading, tool-name mapping, API-key verification, authorization, audit writing and upstream error handling. Search before adding a helper, and don't abstract for a single caller.
- Read and validate config once at startup. Fail fast with a clear message.
- Validate external input at the boundary: HTTP bodies, tool arguments, environment variables and upstream responses. Don't re-validate inside trusted internal calls.
- Handle errors where something can be done about them. No blanket try/catch and no swallowed errors.
- Errors returned to the browser, an MCP client or the LLM are sanitized: no stack traces, internal URLs or credentials.
- No unused parameters, options, flags or code paths.
- Existing code in the repo sets the conventions. The formatter and linter are configured from the start, and all code passes both.

### Comments

- Give exported functions, and any function whose behavior isn't obvious from its name and signature, a short doc comment. It says what the function does and, where relevant, what it throws or what side effects it has. One to three lines is usually enough; don't restate parameter types.
- Inline comments explain intent, constraints and edge cases: why a timeout exists, why a check is there, why the order matters.
- No comments that narrate the code, no section banners, no "Step 1" comments, no commented-out code. Update comments when the code changes.

```ts
/**
 * Reads and validates gateway settings from the environment.
 * Throws with every missing or invalid variable, so a bad values file fails at startup.
 */
export function loadConfig(env: NodeJS.ProcessEnv): GatewayConfig {
```

```ts
// Upstreams are listed in parallel, so a slow server costs its own timeout
// instead of delaying the whole response.
```

### Logging

Log one line per meaningful event, with structured fields (server, tool, user id, duration, outcome). No progress chatter such as "Starting…" or "Successfully…", no emoji, and never secrets.

### Tests

Cover the logic that is easy to get wrong:

- tool-name mapping and collisions
- routing
- key verification and revocation
- role checks
- timeouts and dead upstreams
- audit entries for failed and rejected calls

Test names describe behavior. There is no coverage target.

### Writing (docs, commits, UI text)

Use plain, direct sentences. No marketing words ("robust", "seamless", "leverage", "comprehensive"), no emoji, no filler introductions or recaps. Use headings and lists only where they help a reader find something.

## Engineering rules

### Kubernetes and Helm

- Use Helm only, no Kustomize. The same charts deploy locally and to the VPS; differences live only in the values files.
- Everything runs in the cluster: store, database, WooCommerce MCP server, gateway backend and dashboard.
- Every workload has readiness and liveness probes, and resource requests and limits. Probes check something meaningful.
- Gateway readiness must not depend on upstream health. One dead upstream must not take the gateway out of its Service.
- The store database and WordPress content use PersistentVolumeClaims.
- The storefront and dashboard are exposed through Ingress on stable hostnames.
- The WooCommerce MCP server has no Ingress. It is a ClusterIP Service with a NetworkPolicy that allows traffic only from the gateway.
- Image tags are pinned; never use `latest`. Containers run as non-root wherever the image allows.

### Secrets and credentials

- Credentials live only in Kubernetes Secrets. Never put them in source code, Dockerfiles, committed values files, logs or error messages. The README documents how to create the Secrets.
- Upstream credentials stay in the backend. They never reach an API response, the browser, an MCP client, the LLM context or the logs.
- API keys are generated with a cryptographically secure random source, shown once, and stored only as a hash. Revocation applies from the next call.
- Client API keys are never forwarded to upstream servers.
- The LLM API key is a Secret like any other.

### Gateway

- Only the gateway calls upstream MCP servers, and that includes the chat agent.
- The chat agent's tool calls go through the same authorization and audit path as external clients, acting as the logged-in user. No path skips these checks.
- Every tool call is audited (succeeded, failed, timed out or rejected) with user, server, tool, timestamp, duration and outcome.
- Upstream tool descriptions and results are untrusted input.

### WooCommerce MCP server

- It is implemented in this repo. Don't install an existing WooCommerce MCP server or plugin.
- It speaks MCP over Streamable HTTP.

## Requirements

**Kubernetes**
- K1 Runs on local Kubernetes (Kind, k3d or Minikube).
- K2 Deploys to a VPS (k3s) with the same charts; only values change.
- K3 Helm only.
- K4 All components run in the cluster.
- K5 Persistent storage for the store database and WordPress content.
- K6 Ingress with stable URLs for the storefront and dashboard. The local domain approach is documented.
- K7 Probes and requests/limits on every workload.
- K8 No hardcoded secrets; Kubernetes Secrets only.

**WooCommerce MCP server**
- W1 Implemented in this repo.
- W2 Streamable HTTP.
- W3 Tools: list products, create product, list orders, get order, update order status.
- W4 Unreachable from outside the cluster; only the gateway can call it.
- W5 How it talks to the store, and why, is documented.

**Gateway**
- G1 Admins add, edit, disable and remove upstream servers (Streamable HTTP), each with an optional static credential (header or bearer token).
- G2 One MCP endpoint. `tools/list` returns the tools of all enabled servers, and `tools/call` routes to the right server.
- G3 Tool-name collisions are handled by a documented scheme.
- G4 A slow or dead upstream doesn't break listing or calls to other servers. Calls time out with a clear error.
- G5 Upstream credentials stay server-side.
- G6 At least three upstreams: WooCommerce plus two others.
- G7 The dashboard lists servers with status (Connected / Unreachable / Disabled) and their tools. WooCommerce is pre-registered.

**Team and access**
- T1 Roles: admin (manages servers and members) and member (uses tools).
- T2 Per-user API keys. Members generate their own; admins can issue and revoke them. Keys are stored hashed.
- T3 Admins invite team members.
- T4 Audit log of every tool call (user, server, tool, timestamp, duration, outcome), visible in the dashboard.

**Chat agent**
- C1 Chat in the dashboard. An LLM calls tools through the gateway, and the UI shows which tools were called.
- C2 It acts as the logged-in user, so its calls are audited under that user.
- C3 The LLM key is in a Secret. Any provider, free tier or local model is fine.

## Acceptance criteria

Run with two users, A and B.

- D1 On the storefront, add a product to the cart and check out with COD or a dummy gateway. The order is visible in WooCommerce admin.
- D2 User A asks the chat agent to create a product with a name and price. It appears on the storefront.
- D3 Place an order for that product by hand, then ask the agent which orders came in today. It returns that order.
- D4 User B connects Claude Code, Cursor or MCP Inspector using only the gateway URL and B's key. B sees tools from every enabled server and asks the same orders question successfully.
- D5 User B runs one prompt that needs tools from two different upstreams.
- D6 Revoke B's key. B's next call is rejected.
- D7 Disable an upstream. Its tools disappear from both the chat agent and the external client.
- D8 Kill one upstream's pod. The other servers keep working, and the dashboard shows the dead one as Unreachable.
- D9 Every call above appears in the audit log, attributed to the right user.

## Documentation

- **`README.md`**:
  - local setup and VPS (k3s) setup
  - local domain approach
  - how to place an order, connect an external MCP client, and use the chat agent
  - any optional extensions implemented, and where to find them
- **`docs/design.md`**:
  - components and responsibilities
  - request flows and data model
  - Kubernetes topology: what is public, what is internal, and how that is enforced
  - tool aggregation, routing and failure handling
  - decisions and tradeoffs
  - what changes for production (DNS, ingress, storage class, secrets)
  - Helm upgrade and rollback
  - a short requirement-to-mechanism table
- **`docs/threat-model.md`**:
  - what a member can do with shared upstream credentials they never see
  - why client tokens are not passed to upstreams
  - untrusted upstreams and manipulative tool descriptions
  - what one member can do to another
  - what happens if an admin adds a malicious or compromised server

## Design document

`docs/design.md` must answer each of these with the options considered, the tradeoff and the decision:

- How does the MCP server talk to WooCommerce: REST API, WP-CLI or direct database access?
- How are WordPress and WooCommerce installed and configured on first deploy (site setup, plugin, COD, REST credentials) so that `helm install` produces a working store without manual steps? How do the store credentials reach the MCP server as a Secret?
- Does the gateway keep a session per upstream or connect per request? How is upstream status determined and refreshed?
- What is the tool-name namespacing scheme? How does a name map back to its upstream, and does the scheme fit the tool-name limits that clients enforce? Check, don't guess.
- How do connected clients learn that the tool list changed (D7): `notifications/tools/list_changed`, re-listing, or both?
- What are the timeouts for listing and for calls? What is the fan-out strategy? Are tool lists cached, and how is the cache invalidated?
- How do humans log in to the dashboard, as opposed to MCP clients using API keys? How do invites work without email?
- What is the API-key format and hashing choice, and why does a fast hash or a password hash suit random, high-entropy keys?
- How does the chat agent call tools as the logged-in user through the same auth and audit path?
- Which two additional upstream servers, where do they run, and which prompt demonstrates D5?
- Which database does the gateway use, and where does its data persist?
- Which Ingress controller and local domain approach?
- Does the local cluster's CNI enforce NetworkPolicies? If not, how is W4 demonstrated?
- Is the gateway's MCP endpoint stateful? What would break with more than one replica?