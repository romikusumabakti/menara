# MCP server

Menara is an [MCP](https://modelcontextprotocol.io) server, so people can work
with it from their own AI clients: ask why a deploy failed, list the issues
assigned to them, look at a table, move an issue or deploy a build to a dev
environment, without opening the UI.

Each person signs in with their own Menara account and approves the client
once. The agent then sees and does exactly what that person's role allows,
narrowed to the scopes they granted. A role change, a project-membership
change or a ban applies to the very next call.

The endpoint is `https://<your instance>/api/mcp` (Streamable HTTP, stateless;
MCP 2026-07-28, and 2025-11-25 clients through the SDK's legacy handling). The
exact URL is shown in Account › Connected apps and in Admin › Instance › MCP.

## Turning it on

The server is off on a new install. An admin turns it on in Admin › Instance ›
MCP with **Allow MCP clients**. While it is off, `/api/mcp`, the OAuth
endpoints under `/api/auth/oauth2/*` and the discovery documents answer 404,
and every connected app stops at its next call. Grants are kept, so turning it
back on restores them. A switch reaches every app process within 5 seconds.

## What it exposes

Read tools (scope `read`, always granted) mirror the Assistant's own tools, on
the same code, with the same per-person scoping, secret and personal-data
filters and limits: projects, issues, the overview,
people, recent activity, environments and their status, builds and deploys,
servers and service logs, code (list, read, search) and knowledge.

| Scope | Tools |
| --- | --- |
| `read` | the read tools above (required on every grant) |
| `database:read` | `list_tables`, `query_database`: only on environments where Assistant database access is on, through the same read-only role. Query results go to the AI model the client uses. |
| `issues:write` | `create_issue`, `update_issue`, `add_issue_comment` |
| `deploys:write` | `deploy`, `rollback` |

Clients may also ask for `offline_access` (refresh tokens). Every write runs
the same permission check as the matching UI action, respects deploy locks,
and is recorded in the activity log as the person, "via <client>".

### The environment rule

Agents may `deploy` and `rollback` only on environments whose kind is `dev`,
`qa` or `sandbox`. Any other kind (`release`, `prod`, `demo`, or no kind set)
is refused with the code `mcpEnvironmentReadOnly`; use the UI for those.
Reads work wherever the person's role allows.

### Limits

Per person and client: 120 read calls and 20 write calls a minute. Over the
limit the call gets HTTP 429 with `Retry-After`. Logs never contain tokens,
tool output or rows.

## Connecting a client

Clients register themselves through a Client ID Metadata Document (CIMD);
there is no dynamic client registration and nothing to set up per client on
the server. On first use the client opens Menara in the browser: sign in as
usual (password + authenticator, passkey or Microsoft), then approve. You can
untick every scope except `read`.

Account › Connected apps shows these steps with the instance's own URL, each
snippet ready to copy. `<name>` is the instance name, slugged (`menara` by
default). No client needs a token: each one opens the browser for the sign-in
and approval above.

- **Claude Code**: add the server at user scope, so it is there in every
  project, then sign in:

  ```sh
  claude mcp add --scope user --transport http <name> https://<your instance>/api/mcp
  claude mcp login <name>
  ```

  (`/mcp` inside a session does the same sign-in.)

- **Zed**: Settings › AI › MCP Servers › Add Server › Add Remote Server, and
  replace the template with the block below. Leave out `headers`: without an
  `Authorization` header Zed runs the OAuth flow. The same block also works
  under `context_servers` in `settings.json`.

  ```json
  { "<name>": { "url": "https://<your instance>/api/mcp" } }
  ```

- **claude.ai / Claude Desktop**: Customize › Connectors › + Add › Add custom
  connector, with the name `<name>` and the URL
  `https://<your instance>/api/mcp`. On Team and Enterprise plans an owner adds
  it first under Organization settings › Connectors; members then choose
  Connect.

## Behind an access proxy

If the instance sits behind an access proxy (Cloudflare Access, an SSO
gateway), agents must reach the machine-to-machine paths without a browser
sign-in. Let these through:

- `/api/mcp`
- `/.well-known/oauth-protected-resource*`
- `/.well-known/oauth-authorization-server*`
- `/api/auth/.well-known/oauth-authorization-server`
- `/api/auth/oauth2/token`
- `/api/auth/oauth2/revoke`
- `/api/auth/jwks`

Keep `/api/auth/oauth2/authorize` and the consent page behind the proxy: a
person opens those in a browser, signed in to the proxy already. The
authorization server sends the browser to `/oauth/consent`, which the app
serves as `/<locale>/oauth/consent` (for example `/en/oauth/consent`).

## Revoking access

- **Your own apps:** Account › Connected apps lists each app you approved, its
  scopes, when you approved it and when it was last used. **Revoke** ends it.
- **Anyone's apps:** admins see every grant in Admin › Instance › MCP and can
  revoke any of them.

A revoke deletes the grant, revokes the app's refresh tokens and deletes its
stored access tokens in one transaction. Access tokens are short-lived JWTs
(one hour), but the endpoint checks the grant on every call, so the app stops
at its very next request. Approving the app again makes a new grant: tokens
issued under the revoked one stay refused. Approving and revoking are recorded in the activity
log, and so is the instance switch.
