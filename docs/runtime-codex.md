# Codex runtime compatibility — codex-cli 0.147.0 on macOS

Work package: **WP03 — first real adapter (FR003, FR058, initial FR042 boundary checks)**
Adapter: `src/adapters/codex/` · Transport: `src/adapters/codex/rpc.ts` · Protocol types: `src/adapters/codex/protocol.ts`

| Fact | Value |
| --- | --- |
| Executable tested | `/opt/homebrew/bin/codex`, `codex-cli 0.147.0` |
| Platform | macOS 26.6.2, arm64 (`process.platform === 'darwin'`) |
| Authentication | ChatGPT sign-in (`codex login status` → "Logged in using ChatGPT") |
| Protocol source of truth | `codex app-server generate-json-schema` output for this exact build |
| Date checked | 2026-09-07 |

Everything below was executed against that installed build. Where a statement is not backed by an
executed check it says so.

## 1. Which interface the adapter drives, and why

**Primary and only implemented mode: the app server over stdio** — `codex app-server --stdio`
(equivalently `--listen stdio://`), one owned server process per conversation session.

`codex exec --json` was considered as the secondary mode described in the work package. It is not
implemented, because the app server supplies every control the adapter contract requires and
`codex exec` supplies only some of them:

| Control the contract needs | app server | `codex exec --json` |
| --- | --- | --- |
| Stable session identity across turns | `thread/start` → thread id | session id only via `exec resume` |
| More than one turn per session | `turn/start` per turn | one prompt per process |
| Mid-turn steering | `turn/steer` | none |
| Interruption with an observed confirmation | `turn/interrupt` → `turn/completed` status `interrupted` | signal the process and guess |
| Per-turn sandbox with explicit writable roots | `turn/start.sandboxPolicy` | `-s <mode>` + `--add-dir`, no `/tmp` exclusion |
| Refusable approval requests | server → client requests | none; approvals are terminal prompts |

If a future codex build removes an app-server control this adapter needs, the fallback is to add the
`codex exec` mode behind the same interface and mark the missing capabilities `unsupported` for that
version — not to relax the execution profile.

## 2. Exact protocol used

### Handshake

1. `initialize` with `{ clientInfo: { name: "workforce", version: "0.1.0" } }`.
   The response carries `userAgent`, `codexHome`, `platformOs`, `platformFamily`.
2. the `initialized` notification (no params) — the only client notification the protocol defines.

### Client requests this adapter sends

| Method | When | Params this adapter sends |
| --- | --- | --- |
| `initialize` | once per process | `clientInfo` |
| `thread/start` | `openSession` | `cwd`, `sandbox`, `approvalPolicy: "never"`, `developerInstructions`, optional `model` |
| `thread/resume` | `resumeSession` | the same plus `threadId` |
| `turn/start` | `startTurn` | `threadId`, `input: [{ type: "text", text }]`, `approvalPolicy: "never"`, `sandboxPolicy`, optional `model`/`effort` |
| `turn/steer` | `deliver` while a turn is active | `threadId`, `expectedTurnId`, `input` |
| `turn/interrupt` | `interrupt` | `threadId`, `turnId` |
| `model/list` | `discoverSettings` | `{}` |
| `command/exec` | `execInSandbox` (boundary checks) | `command` argv, `cwd`, `sandboxPolicy`, `timeoutMs` |

### Server notifications consumed

`thread/started` → `session_started` · `turn/started` → `turn_started` ·
`turn/completed` → `turn_completed` (or `turn_interrupted` when `status === "interrupted"`) ·
`error` → `error` · `item/started` and `item/completed` → `assistant_message`, `command_exec`,
`file_change`, `tool_call`, `tool_result` by `item.type` · `thread/tokenUsage/updated` → captured as
usage and kept as a `raw` event.

Everything else — `thread/status/changed`, `mcpServer/startupStatus/updated`,
`account/rateLimits/updated`, `warning`, `turn/diff/updated`, methods that do not exist yet — becomes a
`raw` event with its method and params intact. Streaming delta methods
(`item/agentMessage/delta`, `item/reasoning/*Delta`, `item/commandExecution/outputDelta`, …) are
filtered from the normalized stream by default (`includeDeltas: true` re-enables them) and are always
present in the raw capture.

### Server → client requests, and how they are answered

Every server → client request in `ServerRequest.json` asks the client to authorize something. All but
one are escalations — a request for reach the run was not configured with — and the transport answers
those from a fixed refusal table. The policy hook **cannot be configured to approve one**: it may only
change the shape of a refusal, and a decision that claims not to be denied is discarded in favour of
the built-in denial.

| Request | Answer |
| --- | --- |
| `item/commandExecution/requestApproval` | `{ decision: "decline" }` |
| `item/fileChange/requestApproval` | `{ decision: "decline" }` |
| `execCommandApproval`, `applyPatchApproval` (legacy) | `{ decision: { denied: { rejection: … } } }` |
| `item/permissions/requestApproval` | `{ permissions: {}, scope: "turn" }` — grants nothing |
| `mcpServer/elicitation/request` | `{ action: "decline" }`, except a coordination-bridge tool call (below) |
| `item/tool/requestUserInput` | `{ answers: {} }` — the coordinator is not the user |
| `item/tool/call` | `{ success: false, contentItems: [ … refusal text … ] }` |
| `account/chatgptAuthTokens/refresh`, `attestation/generate`, anything unknown | a JSON-RPC error, never data |

With `approvalPolicy: "never"` on both the thread and every turn, no *command or patch* approval
request was observed during the real runs; those rows exist so that a build which asks anyway is
refused rather than silently widened.

#### The one request that is not an escalation

`approvalPolicy: "never"` does **not** cover MCP tool calls. 0.147.0 gates every one of them behind
`mcpServer/elicitation/request`, observed as:

```json
{"method":"mcpServer/elicitation/request","params":{
  "threadId":"…","turnId":"…","serverName":"workforce","mode":"form",
  "message":"Allow the workforce MCP server to run tool \"send_message\"?",
  "requestedSchema":{"type":"object","properties":{}},
  "_meta":{"codex_approval_kind":"mcp_tool_call","persist":["session","always"],
           "tool_description":"…","tool_params":{"body":"probe hello"}}}}
```

Answering `{ action: "decline" }` fails the call with `error.message: "user rejected MCP tool call"`,
so a blanket refusal makes the coordination bridge (FR033) unusable: the coordinator withdraws the
channel it configured, and a multi-worker run exchanges nothing.

The transport therefore approves this request with `{ action: "accept", content: {} }` when, and only
when, **all** of the following hold (`bridgeToolUnderAuthorization` in `src/adapters/codex/rpc.ts`):

1. the session was provisioned with a bridge at all — recognized from this session's own
   `-c mcp_servers.<name>.args=["<bridge entry>"]` override, where the entry path is the
   coordinator's own bridge module, not a name anyone else can choose;
2. `params.serverName` **equals** that registered server name (never a substring or prefix test);
3. `mode` is `form` and `_meta.codex_approval_kind`, when present, is `mcp_tool_call`;
4. `requestedSchema` asks for no fields — we answer with empty content, and inventing form input
   would be answering for the human;
5. the tool is one the bridge exposes. The elicitation does not name it, so it is taken from the
   `mcpToolCall` item the server starts immediately before asking (`server` + `tool`), and every MCP
   call in flight on the thread must be a bridge call for the attribution to be unambiguous.

Anything else — including an elicitation from any other MCP server, a `url`-mode flow, a form asking
for data, or a tool the bridge does not expose — keeps the ordinary refusal, with the failed clause
appended to the recorded reason. Every decision, approval and refusal alike, is kept in
`serverRequestDecisions(handle)` with its reason.

### Two deviations from textbook JSON-RPC 2.0

- The server omits the `"jsonrpc": "2.0"` member on every frame it sends. The decoder does not
  require it. Our own frames still carry it (the server accepts them), which keeps recorded
  transcripts self-describing.
- Notifications carry an extra top-level `emittedAtMs` member beside `params`.

## 3. Configuration overrides

`thread/start` has **no `effort` parameter** in this protocol version, and passing one is silently
ignored. Model and reasoning effort are therefore set as process-level config overrides, which the
`thread/start` response then echoes back as the values that actually took effect:

```
codex app-server --stdio -c model="gpt-5.6-sol" -c model_reasoning_effort="low"
```

Verified: `-c` is accepted both before the `app-server` subcommand and after the transport flags. The
adapter appends it after. Override values are restricted to `[A-Za-z0-9._:-]` before being
interpolated into the TOML expression, so a configured value cannot reshape it into a second setting.

`turn/start.effort` and `turn/start.model` are sent as well, so a per-turn change does not need a new
process.

## 4. Sandbox behaviour actually observed

`thread/start` only accepts the coarse `SandboxMode` enum. The writable roots — the part that
actually bounds a worker — live in the turn-scoped `SandboxPolicy`, so the adapter sends them on
every `turn/start`.

| Execution profile (plan section 8) | `thread/start.sandbox` | `turn/start.sandboxPolicy` |
| --- | --- | --- |
| `analysis` | `read-only` | `{ type: "readOnly", networkAccess: false }` |
| `verification` | `read-only` | `{ type: "readOnly", networkAccess: false }` |
| `local-development` | `workspace-write` | `{ type: "workspaceWrite", writableRoots: [granted…], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true }` |

`danger-full-access` is never produced by this mapping.

### The `/tmp` finding

**Codex's `workspaceWrite` policy leaves `/tmp` and `$TMPDIR` writable unless you say otherwise.**
Measured with `command/exec` under the same policy shape a turn uses:

| Policy | Write to `/tmp/<random>/x` | Write to `$TMPDIR/<random>/x` |
| --- | --- | --- |
| `workspaceWrite` with `writableRoots: [A]`, defaults | **exit 0, file created** | **exit 0, file created** |
| the same plus `excludeSlashTmp: true`, `excludeTmpdirEnvVar: true` | exit 1, `Operation not permitted` | exit 1, `Operation not permitted` |

A worktree plus the default `workspace-write` would therefore **not** be a boundary: a worker could
write outside every granted path. The adapter always sets both exclusions, so the granted roots are
the whole writable set.

### Boundary results (`tests/adapters/codex/real-runtime.test.ts`)

With `writableRoots: [A]`, `excludeSlashTmp`, `excludeTmpdirEnvVar`, network off:

| Action | Result |
| --- | --- |
| write inside granted root A | exit 0, file present with the expected bytes |
| write into sibling workspace B | exit 1, `Operation not permitted`, no file |
| write into `$TMPDIR/<random>/` | exit 1, `Operation not permitted`, no file |
| write into `/tmp/<random>/` | exit 1, `Operation not permitted`, no file |
| `curl https://example.com` | non-zero exit (DNS refused) |
| write inside A under the `analysis` profile | exit 1, `Operation not permitted`, no file |
| read `A/README.md` under the `analysis` profile | exit 0, contents returned |

The same boundary was then checked through a **model-driven turn**: a turn under
`local-development` rooted at A was asked to write `<escape>/escape.txt` outside A and to append to a
file in sibling repository B. Neither write occurred, B's file was byte-identical afterwards, the
refusal was visible in the event stream, and no server → client escalation was approved.

## 5. Capability statuses for codex-cli 0.147.0 on macOS

Machine-readable copy: `docs/verified-capabilities.json`.

| Capability | Status | Evidence |
| --- | --- | --- |
| `structured_events` | verified | real sessions produced `thread/started`, `turn/started`, `item/*`, `thread/tokenUsage/updated`, `error`, `turn/completed`; all normalized |
| `session_identity` | verified | `thread/start` returns a stable thread id reused by every later request, notification and resume |
| `resume_session` | verified | a thread was resumed by id in a second app-server process after the first was terminated and answered from the earlier turn's history |
| `interrupt_turn` | verified | `turn/interrupt` ended a running shell loop; `observed` only after `turn/completed` with status `interrupted` |
| `active_turn_delivery` | verified | `turn/steer` with `expectedTurnId` accepted mid-turn; receipt `submitted_to_active_turn` |
| `queued_delivery` | verified | a delivery with no active turn is queued and flushed into the next `turn/start` input |
| `process_tree_stop` | verified | stdin close → SIGTERM → SIGKILL on the owned process group; observed group state reported |
| `write_containment` | verified | the boundary table above, through both `command/exec` and a model-driven turn |
| `model_selection` | verified | `model/list` reports ids; `-c model=` echoed by `thread/start` and used by the turn |
| `effort_selection` | verified | `model/list` reports efforts per model; `-c model_reasoning_effort=` echoed by `thread/start` |
| `usage_reporting` | verified (tokens only) | `thread/tokenUsage/updated` reports input, cached input, output and reasoning tokens. **Currency cost is not reported at all** |
| `coordination_bridge` | verified | injected as `-c mcp_servers.<name>....`; a real turn called the bridge tool `send_message`, the app server asked through `mcpServer/elicitation/request`, the adapter authorized that one request, the `mcpToolCall` item completed with status `completed`, and the coordinator stored the message |

Models reported by `model/list` on this machine: `gpt-5.6-sol` (default), `gpt-5.6-terra`,
`gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`.
Reasoning efforts reported: `low`, `medium`, `high`, `xhigh`, `max`, `ultra` (the set is per model).

Before `model/list` has been consulted the adapter offers nothing and marks both lists
non-exhaustive, so a requested value is reported `supported_unverified` and passed through unchanged
rather than being mapped or rejected. After discovery the lists are exhaustive and an unknown model
is refused before anything is spawned.

## 6. Known limitations

1. **Currency cost is unavailable.** Token counts are reported per turn; there is no price. Anything
   presenting cost must label it unavailable, never zero.
2. **The user's `config.toml` default model can be incompatible with the installed CLI.** On this
   machine the configured default was `gpt-6-astra`, and a turn using it failed with HTTP 400
   *"The 'gpt-6-astra' model requires a newer version of Codex"*. The adapter raises a session
   diagnostic when the thread's reported model is absent from `model/list`; a run should pin a model
   from the discovered table rather than inherit the user's default.
3. **The user's configured MCP servers start with every thread.** `thread/start` loads them from
   `~/.codex/config.toml`; `-c mcp_servers={}` did **not** suppress them in 0.147.0. They are
   children of the owned process group, so `stopOwnedProcesses` does clean them up, but they add
   about 1–2 s of startup noise and are a surface this adapter does not control. Their status
   notifications reach the event stream as `raw` events.
4. **`thread/resume` needs a persisted rollout.** Resuming a thread that never ran a turn fails with
   `-32600 "no rollout found for thread id …"`. Resume after at least one completed turn works.
5. **`thread/start` echoes an empty `writableRoots`.** The thread-level `sandbox` field reports
   `{"type":"workspaceWrite","writableRoots":[],"excludeSlashTmp":false,"excludeTmpdirEnvVar":false}`
   even when the turn policy grants roots and sets the exclusions. Do not read that echo as the
   effective boundary; the turn-scoped `sandboxPolicy` is what is enforced, as the boundary results
   show.
6. **`turn/interrupt` with no active turn** returns `-32600 "no active turn to interrupt"`. The
   adapter converts that into a receipt (`observed` if the turn already ended, otherwise `requested`)
   rather than an error.
7. **A completed turn is a runtime claim, not acceptance.** `turn_completed` carries
   `evidence: "runtime_reported"` and nothing in the adapter marks a task accepted; a final assistant
   message sets `claimsDone` only from the runtime's own `phase: "final_answer"` marker, never from
   reading the prose.
8. **The app server also exposes `thread/shellCommand`, which the schema documents as running
   unsandboxed with full access.** This adapter never calls it.
9. `codex-cli 0.147.0` logs `failed to load models cache: missing field supports_parallel_tool_calls`
   to stderr on some invocations. It is captured in the raw log and does not affect the protocol.
10. **`workspaceWrite` bounds writes and network, not reads.** `SandboxPolicy` has no read scope in
    this protocol version, so a worker under `local-development` can read any file the user can read.
    Measured with `command/exec` under the policy a turn gets — the full output is
    `docs/evidence/r0/sandbox-boundary.txt`:

    | Action under `local-development`, `writableRoots: [A]` | Result |
    | --- | --- |
    | write inside A | exit 0 |
    | write outside A | exit 1, `Operation not permitted` |
    | **read a file outside A** | **exit 0, contents returned** |
    | `curl https://example.com` from a worker tool | exit 6, host not resolved |

    A model-driven turn exercised this during an R0 rehearsal on the same fixture and configuration:
    it ran `rg -n "paginate|pagination|…" ~/.codex/memories/MEMORY.md` from inside the candidate
    worktree and the read was permitted. The two runs kept in `docs/evidence/r0/` happen not to
    contain that command, because the model chose different commands each time; the probe above is
    the deterministic evidence.

    Nothing was written outside the granted roots and nothing left the machine, but the plan's
    `local-development` wording ("read/write the assigned candidate and scratch/build paths") is
    **not** enforced for the read half by this runtime. Read confinement needs an isolated
    environment around the process; it is not a policy this adapter can claim, and the run manifest's
    `evidence.containmentNote` says so.

## 7. Measured timings

From `tests/adapters/codex/real-runtime.test.ts` on the recording machine (warm, one sample each —
these are observations, not performance claims):

| Measurement | Value |
| --- | --- |
| passive probe (`--version` + `login status`) | 188 ms |
| `model/list` (spawn, initialize, list, stop) | 1 084 ms |
| process start → `thread/start` response | 274 ms (190–355 ms across runs) |
| `openSession` → `turn/start` accepted | 8 ms |
| first normalized event after `turn/start` | 205 ms (`session_started`) |
| first tool action of a real turn | 8.4 s (8.4–13.7 s across runs) |
| tiny turn to `turn_completed` | 24.0 s (24.0–107.3 s across runs) |
| `turn/steer` request → receipt | 3 ms |
| `turn/interrupt` request → observed terminal event | 7 ms |
| `thread/resume` in a fresh process | 160 ms |
| `stopOwnedProcesses` (whole group, no signal needed) | 495 ms |
| tokens for the tiny "create hello.txt" turn | 20 480 total (20 416 input, 12 032 cached, 64 output) |

## 8. Fixtures and how to run the checks

`fixtures/codex/fake-app-server.mjs` replays a recorded transcript so framing, normalization,
steering, interruption and shutdown can be tested with no network, no model turn and no quota.

| Fixture | Provenance |
| --- | --- |
| `session-usage-limit.real.jsonl` | **recorded from the installed runtime.** A real turn that the provider refused with `codexErrorInfo: usageLimitExceeded`. Machine identifiers and the recording user's home directory were replaced with placeholders; every other field is verbatim |
| `session-hello.synthetic.jsonl` | synthetic, hand-built from this build's JSON Schema: command execution, file change, final answer, unknown method, unknown fields |
| `session-interrupt.synthetic.jsonl` | synthetic: the server waits for `turn/interrupt` before finishing the turn |
| `session-denied.synthetic.jsonl` | synthetic: an approval request to refuse, a write outside the granted roots, a sandbox-denied command |
| `session-claims-done.synthetic.jsonl` | synthetic: a final answer claiming completion with no file change |

```sh
npm run typecheck
npm test                                     # deterministic; real-runtime checks are skipped

# real runtime; the "model turns" block spends ChatGPT quota
WORKFORCE_REAL_RUNTIMES=1 \
WORKFORCE_CODEX_PATH=/opt/homebrew/bin/codex \
  npx vitest run tests/adapters/codex/real-runtime.test.ts
```

The real-runtime file is split so the control-plane and containment checks cost nothing and always
run under the gate, while the checks that need a completed turn record why they could not run when
the account is over its usage limit and report as **skipped**. A skipped check is not a passing check.

## 9. Provider failure observed on this machine

An earlier run of the same suite hit the account's usage limit. The failure path is real evidence and
is preserved as the recorded fixture:

```
error       { errorClass: "usage_limit", willRetry: false,
              message: "You've hit your usage limit. …" }
turn_completed { status: "failed", errorClass: "usage_limit", evidence: "runtime_reported" }
```

No file was written, `summarizeTurnEvidence` reported no file changes, and nothing marked the task
complete. `codexErrorInfo` values are mapped to a coarse class (`usage_limit`, `authentication`,
`provider_transient`, `context_window`, `sandbox`, `request_rejected`); a code this build does not
document stays `unknown` rather than being guessed into a retryable class.
