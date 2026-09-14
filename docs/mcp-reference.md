# MCP technical reference

AI Workforce exposes a local **stdio MCP server**. A coding agent can discover your projects,
save an issue or complete PRD, read the project Kanban board, and explicitly send an issue to
Control Center. The connection uses the same running workspace server and request queue as
the browser app. It adds no execution service or separate agent roster.

## Start the workspace

Run these commands in a terminal:

```sh
cd "/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee"
npm run build
/opt/homebrew/bin/node dist/cli/index.js serve --port 4421 --open
```

Use the same `--state-dir` as your ordinary workspace when it has a custom state root.
Only one page server should own that workspace queue. If the app is already running on
4421, use it; do not start another copy. The bridge defaults to
`http://127.0.0.1:4421`; its `--server-url` selects another already-running local port.
The bridge does not select or create a state root.

Connecting an MCP client, initializing the protocol and listing tools start no model turns.
Calling a read tool contacts the running server. Saving an issue with `start:false` writes
the issue only. Starting an issue can spend model turns through the configured coding runtimes.

## Codex

Add the server through the installed Codex CLI:

```sh
/opt/homebrew/bin/codex mcp add ai-workforce -- /opt/homebrew/bin/node "/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/dist/cli/index.js" mcp --server-url http://127.0.0.1:4421
```

This command changes Codex's MCP configuration. It is provided for you to run; building the
workspace does not run it or change any global coding-agent settings. The equivalent entry
for a Codex MCP configuration is in [the Codex example](examples/mcp-codex.toml).
Reload/reopen the Codex task as needed to load the connection, then ask it to call
`workforce_list_projects`. A configured server entry establishes configuration only; a
successful tool call establishes that the running workspace is reachable.

## Claude Code

Add the same local server for your user:

```sh
/opt/homebrew/bin/claude mcp add --transport stdio --scope user ai-workforce -- /opt/homebrew/bin/node "/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/dist/cli/index.js" mcp --server-url http://127.0.0.1:4421
```

The `--scope user` setting makes the connection available across your Claude Code projects.
Use `--scope local` to keep the registration local to the current project. In Claude Code,
`/mcp` shows connection state and tools. The equivalent JSON configuration is in
[the Claude example](examples/mcp-claude.json). For a temporary session, you can pass that
file to `claude --mcp-config "/absolute/path/to/mcp-claude.json"`.

These executable and repository paths match this Mac. On another machine, replace them
with the actual absolute Node executable and built `dist/cli/index.js` paths. Using absolute
paths makes the connection independent of the repository in which Codex or Claude starts.
The stdio command is the MCP endpoint; the `--server-url` address is its local HTTP backend
and should not be entered as a remote HTTP MCP endpoint.

## Send a plan or PRD

Ask your coding agent to list projects and use the returned project ID. A prompt such as
this makes both the content and intended effect explicit:

> Send the complete PRD we just agreed on to AI Workforce for project `my-project` and
> start work. Keep all requirements and acceptance criteria in the description. Use the
> idempotency key `billing-settings-prd-v1`, and reuse that exact key if the submission times out.

The corresponding call to `workforce_submit_plan` is:

```json
{
  "projectId": "my-project",
  "title": "Billing settings",
  "description": "# PRD\n\nComplete original requirements, constraints, and acceptance criteria go here.",
  "kind": "prd",
  "idempotencyKey": "billing-settings-prd-v1",
  "start": true
}
```

Omit `start` or set it to `false` to save the document to Backlog. The bridge saves one issue
for the complete document. Starting it sends the title, a blank line and the original
description to Control Center. Control Center routes it to the appropriate configured
department; its head plans against the eligible roster, and the existing coordinator owns
admission, worker execution, checks and review. The MCP client does not assign an arbitrary
worker, bypass capacity, or accept its own result.

The original issue description is preserved without summarizing or truncating. Descriptions
are limited to 64,000 characters; the complete title-plus-description execution request must
also fit 64,000 characters, and the HTTP request must fit 256 KiB. Oversized content is refused
explicitly. If a saved issue cannot start, the response retains its issue receipt and exposes
`startError`; the MCP tool result has `isError:true`. Resolve that error and use
`workforce_start_issue` for the saved issue instead of creating a duplicate.

Some configured runtimes require explicit consent to run without verified write containment.
`allowUnconfinedWrites:true` carries that specific consent. The calling agent must not set it
merely because the user asked to start a task. A refusal keeps the issue available in the app.

## Tools and receipts

| Tool | Input | Effect |
| --- | --- | --- |
| `workforce_list_projects` | `{}` | Read registered projects, readiness and workspace revision. |
| `workforce_list_issues` | Optional `projectId`, `limit` (1–100, default 50), `cursor` | Read one page of issue summaries and execution states; pass returned `nextCursor` as `cursor` for the next page. |
| `workforce_get_issue` | `issueId` | Read an issue, revision, original text and linked execution status. |
| `workforce_create_issue` | `projectId`, `title`, `description`, `idempotencyKey`; optional `kind`, `source`, `status`, `start` | Save a project issue; start only when explicitly requested. |
| `workforce_submit_plan` | `projectId`, `title`, `description`, `idempotencyKey`; optional `kind:"plan"\|"prd"`, `source`, `start` | Preserve a plan/PRD and optionally send it to Control Center. |
| `workforce_update_issue` | `issueId`, `expectRevision`, `idempotencyKey`; one or more of `title`, `description`, `status` | Update the saved issue using revision comparison. Does not steer or stop an existing run. |
| `workforce_start_issue` | `issueId`, `expectRevision`, `idempotencyKey`; optional `allowUnconfinedWrites` | Explicitly admit the issue through the existing Control Center queue. |

Status values are `backlog`, `todo`, `in_progress`, `in_review`, and `done`. The displayed board
status of a linked issue follows its recorded execution where applicable. Manually moving a
card to Done is a board action; it does not establish verified execution. An intake receipt,
queued request or runtime claiming success likewise does not establish completion. Read the
issue's `execution` fields and the linked run's checks/review evidence.

Issue lists omit full descriptions so a board with many large PRDs remains readable and
bounded. `workforce_get_issue` returns the selected issue's complete description.

Every mutation requires an idempotency key through MCP: 1–128 characters, starting with a
letter or digit and containing only letters, digits, `.`, `_`, `:`, or `-`. Reuse the same key
**with the same arguments** after an uncertain response. Create and update receipts are
durable; conflicting reuse is refused. Starting an issue is also intrinsically idempotent:
that issue has one stable Control Center request identity. Starting an already linked issue
returns its existing request rather than creating another. Create a new issue for a new task.
Read the current revision before a new update or start; do not rewrite the revision on a
retry of an earlier update.

## Connection failures and boundaries

The bridge accepts only literal `http://127.0.0.1:<port>` origins, verifies `/api/office`
identifies Workforce, refuses redirects, and bounds requests, responses and HTTP timeouts.
It fetches the running app's per-process session token from its own HTML immediately before
a write, then supplies that token and the same local Origin to the existing API gate. No
provider credential store is read, and there is no token to copy into the MCP config.

If the app is stopped, discovery still works, and actual tool calls return
`connection_unavailable` with the expected local URL. Start the correct workspace and retry.
A timed-out mutation may already have been recorded: preserve its idempotency key. A server
restart can invalidate a token between its read and write; retry with the original arguments.
The bridge never silently starts the app, retries a mutation, changes the project roster,
or starts a second queue. Closing the MCP connection does not cancel work already admitted
by the page server. Use the app's normal task controls to stop or resume that work.

The session implements the MCP initialize/initialized lifecycle, ping, tools/list and
tools/call using newline-delimited JSON-RPC over stdin/stdout. Diagnostics go to stderr.
It negotiates the supported 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05 protocol versions;
an unknown requested version receives 2025-11-25 for the client to accept or reject. It does
not advertise MCP resources, prompts, remote HTTP transport or the newer stateless lifecycle.

## Validation and references

`tests/mcp/bridge.test.ts` exercises the actual CLI subprocess handshake, offline discovery,
invalid and oversized frames, notification non-execution, local server identity/redirect
refusals, session-token writes, full document forwarding, mutation keys/revisions, start
failure receipts and visible offline errors. These deterministic protocol tests are separate
from any paid coding-runtime acceptance run recorded in the evidence directory.
`tests/mcp/issues-integration.test.ts` additionally uses the real HTTP server and durable issue
store to page through 33 full-size PRDs, fetch an unchanged full description, and submit the
same MCP save twice with one resulting issue and no runtime launch.

Setup command syntax was checked against installed `codex-cli 0.154.0` and
`Claude Code 2.1.236` using their `mcp add --help` commands on 13 September 2026. It follows the
[MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), and
[MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) specifications.
Claude's setup and scope behavior is documented in
[Claude Code's MCP guide](https://code.claude.com/docs/en/mcp).
