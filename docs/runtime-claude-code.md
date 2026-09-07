# Claude Code runtime compatibility — claude 2.1.260 on macOS

Work package: **WP05 — second adapter (FR004, plus the FR005/FR006 half only a second runtime can prove, and the FR042 containment truth)**
Adapter: `src/adapters/claude-code/` · Transport: `src/adapters/claude-code/transport.ts` · Protocol/argv/policy: `src/adapters/claude-code/protocol.ts`

| Fact | Value |
| --- | --- |
| Executable tested | `~/.local/bin/claude`, `2.1.260 (Claude Code)`, native build, commit `e51f681183f7` |
| Platform | macOS 26.6.2, arm64 (`process.platform === 'darwin'`) |
| Authentication on the recording machine | `claude auth status` → `loggedIn: true`, `authMethod: "claude.ai"`, `subscriptionType: "max"` — **but the runtime itself reports `account.tokenSource: "none"` and every turn fails with `authentication_failed`.** See §9. |
| Protocol source of truth | the installed executable's own `--help`, and recorded stdout/stdin frames |
| Date checked | 2026-09-07 |

Everything below was executed against that installed build. Where a statement is
not backed by an executed check, it says so and says why.

---

## 1. Which interface the adapter drives, and why

**Mode: the documented programmatic mode, held open across turns.**

```
claude --print --verbose
       --output-format stream-json
       --input-format  stream-json
       --replay-user-messages
       --strict-mcp-config
       --setting-sources ''
       --restricted
       --tools <granted tools...>
       --permission-mode <acceptEdits|plan>
       --add-dir <granted directories...>
       --permission-prompts none
       --session-id <uuid the coordinator minted>        # or --resume <id>
       [--model <id>] [--effort <level>] [--max-budget-usd <n>]
       [--include-partial-messages]
       --append-system-prompt <role instructions>
```

One owned `claude` process per conversation session. This is nothing like the
Codex adapter's shape: there is no request/response protocol for turns. A turn
*is* a user message written to stdin; its events arrive as newline-delimited
JSON on stdout; it ends with a `result` record. The process stays alive between
turns, so one session can run many turns without respawning.

The single-shot alternative (`claude -p "prompt"`, one process per turn) was
rejected: it gives no way to interrupt, no way to deliver a message, and no
turn boundary the coordinator can observe — the process simply ends.

Alongside the record stream, the same pipes carry a small control protocol
(`control_request` / `control_response`). That is how this adapter interrupts a
turn and how it asks the runtime which models and effort levels it offers
without starting a model turn.

### Flags established by running the installed binary, not by assumption

| Finding | How it was established | Consequence for the adapter |
| --- | --- | --- |
| `--output-format stream-json` with `--print` **requires `--verbose`** | omitting it → `Error: When using --print, --output-format=stream-json requires --verbose` | always passed |
| `--tools <tools...>` and `--add-dir <directories...>` are **variadic and swallow the positional prompt** | `claude … --tools Read "say hi"` → `Error: Input must be provided either through stdin or as a prompt argument when using --print` | the prompt is never positional (it is a stdin frame), and every variadic option is closed by a non-variadic one |
| `--session-id` must be a **valid UUID** | `--session-id not-a-uuid` → `Error: Invalid session ID. Must be a valid UUID.` | the adapter mints a UUIDv7; the installed build accepts it |
| `--session-id` and `--resume` are **mutually exclusive without `--fork-session`** | `--resume <id> --session-id <id>` → `Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.` | a plain resume passes only `--resume <id>`; the resumed conversation keeps the id we minted. A fork passes `--resume <old> --fork-session --session-id <new>` |
| `--effort <unknown>` is **silently ignored** | `--effort not-a-level` → `Warning: Unknown --effort value 'not-a-level' — ignoring it and using the default effort. Valid values: low, medium, high, xhigh, max.` and the run continues | the adapter's effort list is *exhaustive*: an unknown level is refused before anything is spawned (plan §8: "Do not silently map unsupported reasoning levels") |
| without `--strict-mcp-config` the **user's own MCP servers load** | an init record listed `plugin:chrome-devtools-mcp:chrome-devtools` (`status: failed`) and `plugin:supabase:supabase` (`status: needs-auth`) | always passed; with it, `mcp_servers` is `[]` |
| without `--setting-sources ''` a **project's own `.claude/settings.json` runs** | a `SessionStart` hook placed in the session cwd executed a host command; see §5 | always passed |
| `--add-dir` accepts a **non-existent directory silently** | no error, no diagnostic | the coordinator validates the granted paths itself |
| `--no-session-persistence` leaves no resumable session on disk | used by `discoverSettings`, which must have no side effects | discovery only |

### Environment

The transport spawns with a **sanitized environment** — `PATH`, `HOME`,
`TMPDIR`, `LANG`, `LC_ALL`, `SHELL`, `USER`, `LOGNAME` and nothing else. This is
not hygiene theatre: a coordinator that is itself running under Claude Code
exports `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`,
`CLAUDE_CODE_MESSAGING_SOCKET`, `ANTHROPIC_BASE_URL` and more. A child that
inherits them is not the session we configured; during development one such
child reported `entrypoint: "claude-desktop"` in its own transcript.

---

## 2. Record shapes observed

### stdout — `--output-format stream-json`

| `type` | When | What the adapter does with it |
| --- | --- | --- |
| `system` / `subtype: "init"` | **once per turn**, not once per process | first one → `session_started` (carrying the effective settings); every one → `turn_started` |
| `user` with `isReplay: true` | the `--replay-user-messages` echo of a frame we wrote | `raw` with `reason: "user_message_replay"` — the only submission receipt this CLI gives |
| `user` with `tool_result` blocks | a tool returned | `tool_result` per block |
| `assistant` | a model message | one event per content block: `text` → `assistant_message`, `tool_use` → `tool_call` (plus `file_change` for `Edit`/`Write`/`NotebookEdit`/`MultiEdit`, plus `command_exec` for `Bash`), `thinking` → `raw` |
| `assistant` with `is_api_error_message: true` | a synthetic error message, e.g. `error: "authentication_failed"` | `error` (`fatal: false`) with a classified `errorClass` |
| `result` | end of turn | `turn_completed`, or `turn_interrupted` when we asked for an interrupt or `terminal_reason` names one |
| `control_response` | answer to a `control_request` | settles the pending control call, and is also published as `raw` |
| `stream_event` | partial message chunks (`--include-partial-messages`) | filtered unless `includeDeltas`; always in the raw capture |
| anything else | a future build | `raw` with the record kept intact |
| **a bare non-JSON line** | really happens: `No conversation found with session ID: …` | `raw` with `reason: "non_json_stdout_line"` |

The `init` record carries the effective configuration, and it is the honest
answer to "what did the runtime actually do with our flags":

```json
{"type":"system","subtype":"init","cwd":"…","session_id":"…",
 "tools":["Edit","Glob","Grep","Read","Write"],
 "mcp_servers":[],"model":"claude-opus-5[1m]","permissionMode":"acceptEdits",
 "apiKeySource":"none","claude_code_version":"2.1.260","output_style":"default",
 "capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"],
 "agents":[…],"skills":[…],"slash_commands":[…],"plugins":[]}
```

Note the runtime returns the granted tools **alphabetically sorted**, not in the
order they were passed.

The `result` record carries the turn's outcome and its usage:

```json
{"type":"result","subtype":"success","session_id":"…","is_error":true,
 "result":"Failed to authenticate: OAuth session expired and could not be refreshed",
 "num_turns":1,"duration_ms":63,"duration_api_ms":0,"total_cost_usd":0,
 "usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,
          "cache_read_input_tokens":0,"service_tier":"standard"},
 "modelUsage":{},"permission_denials":[],"terminal_reason":"api_error",
 "queued_turn_count":0,"uuid":"…"}
```

`subtype` values observed: `success` (even when `is_error` is true) and
`error_during_execution` (a resume of an unknown session id, which also carries
an `errors` array).

### stdin — `--input-format stream-json`

A user message:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]},
 "parent_tool_use_id":null,"session_id":"<the id we minted>"}
```

A control request:

```json
{"type":"control_request","request_id":"wf_…","request":{"subtype":"interrupt"}}
```

**A line the CLI cannot parse kills it.** Feeding `{not json` produced
`Error parsing streaming input line (type=unknown, 9 chars): SyntaxError` on
stderr and the process exited 1. Every stdin write in this adapter therefore
goes through one JSON encoder in `transport.ts`; nothing else touches the pipe.
An *unknown* frame type is harmless — it is ignored.

### The control protocol

| Request | Response observed |
| --- | --- |
| `{"subtype":"initialize"}` | a large object with `commands`, `agents`, `output_style`, `available_output_styles`, `models` (each with `value`, `resolvedModel`, `supportsEffort`, `supportedEffortLevels`), `account: {tokenSource, apiProvider}`, `pid`, `current_permission_mode`, `session_state` |
| `{"subtype":"interrupt"}` | `{"type":"control_response","response":{"subtype":"success","request_id":"…","response":{"still_queued":[]}}}` |

Both round-trips start **no model turn**, which is what makes
`discoverSettings` and the session handshake free. The `initialize` response is
also the adapter's liveness handshake: `openSession` does not return until the
process has answered it.

---

## 3. Policy-profile mapping (plan §8)

| Profile | `--permission-mode` | `--tools` | `--restricted` | `--add-dir` | `--permission-prompts` |
| --- | --- | --- | --- | --- | --- |
| `analysis` | `plan` | `Read Glob Grep` | yes | session cwd + granted paths | `none` |
| `local-development` | `acceptEdits` | `Read Glob Grep Edit Write` | yes | session cwd + granted candidate | `none` |
| `verification` | — | — | — | — | — · **the adapter refuses to open a session under it** |

`bypassPermissions` is never emitted. `verification` is refused because that
profile runs configured check commands against a frozen candidate copy — the
check runner's job (`src/verification/`), not a model session; pretending
otherwise would let a runtime "verify" its own work.

### Why `local-development` does not grant a shell

`--restricted` "confines the file tools to the working directories (`--add-dir`
included)". A shell command is **not** a file tool. Granting `Bash` therefore
removes the only write boundary this runtime has, and `local-development`
("read/write the assigned candidate and scratch/build paths") would no longer be
enforced by anything.

So the adapter does not grant `Bash` by default. `allowCommandExecution: true`
grants it explicitly, and when it does:

- the session raises a diagnostic saying the write boundary is gone;
- `mapPolicy` adds a `write_confinement` entry to the profile's *unenforceable*
  list, which travels into the `session_started` event payload.

This is the plan's rule applied literally: *"If an adapter cannot enforce a
required profile, fail that mode or use a supported isolated environment. Do not
silently broaden a profile because a check fails."*

### What the mapping cannot enforce, on every profile

Recorded on every session in `session_started.payload.unenforceable`:

| Aspect | Why |
| --- | --- |
| `process_containment` | Claude Code has no OS sandbox — §5 |
| `worker_network` | no flag denies worker-tool network access; `--restricted` removes `WebFetch` from the tool set, which is a tool-surface reduction, not a network boundary |
| `external_delivery` | no flag stops an attempted push or deployment; the coordinator denies it by withholding credentials and remotes |

---

## 4. Session identity, turns and receipts

**The coordinator owns the identity.** `openSession` mints a UUIDv7 and passes
it as `--session-id`, so the id is known before the process starts and before
any output arrives. Everything else — events, `--resume`, the raw-capture
filename — is addressed by that id. Executed: the runtime echoes it on every
record, and `reconcile` returns it before a single turn has run.

**One turn per session.** `startTurn` refuses while a turn is active. A turn id
is minted by the adapter (`turn-1`, `turn-2`, …) because the CLI supplies none;
correlation is unambiguous precisely because only one turn may be active.

**Delivery.** With no active turn the message is held by the adapter and flushed
into the next turn's user frame — receipt `queued`. With an active turn it is
written to the runtime's stdin, and the receipt is `submitted_to_active_turn`
**only** when the runtime echoes it back (`isReplay: true`) while that turn is
still active. If the write succeeded but no echo arrived, the message is *not*
re-queued locally (the runtime has it) and the receipt says `queued` with a
detail saying so — the adapter never resends and never double-delivers.

Honest caveat: the echo proves the runtime *ingested* the message during the
turn. Whether the model sees it inside that turn or in the next one could not be
observed here, and the runtime's own fields (`queued_turn_count`,
`still_queued`, the advertised `interrupt_cancel_queued_v1`) describe a queue.
That is why `active_turn_delivery` is `supported_unverified`, not `verified`.

**Interruption.** `interrupt` sends the control request, records the
`still_queued` list it gets back, then waits for a terminal record for that
turn. `observed` requires that record; otherwise the receipt is `requested` with
the reason. `stopOwnedProcesses` closes stdin, then SIGTERMs and SIGKILLs the
**process group**, and reports what it observed — never what it asked for.

**Reconciliation.** `reconcile` reports the process identity status
(`alive` / `dead` / `pid_reused` / `unverifiable`), group liveness, the active
turn and the last event sequence. A handle rebuilt after a coordinator restart
with only a pid is reported `unknown` and never signalled.

---

## 5. Containment truth (FR042)

> **Claude Code 2.1.260 provides no OS containment. Its permission system bounds
> what its own tools will do; nothing bounds what the processes it starts may
> do.**

This section is the executed answer to the four questions FR042 asks. Every row
comes from `tests/adapters/claude-code/real-runtime.test.ts`, which runs under
`WORKFORCE_REAL_RUNTIMES=1`.

### 5.1 What the flags DO enforce: the tool surface — verified

Executed. The `init` record lists exactly the tools the runtime will offer the
model, and it matches the profile exactly:

| Configuration | Tools the runtime reported |
| --- | --- |
| no flags | `Task, Bash, CronCreate, …, Edit, Read, WebFetch, WebSearch, Write` (25 tools) |
| `--restricted` alone | Bash, WebFetch and the other code-running tools gone (22 tools) |
| `--restricted --tools Read Glob Grep` (`analysis`) | **`Glob, Grep, Read`** |
| `--restricted --tools Read Glob Grep Edit Write` (`local-development`) | **`Edit, Glob, Grep, Read, Write`** |
| `--disallowedTools Bash Edit Write NotebookEdit` | exactly those four removed |
| `--restricted --tools … Bash …` | Bash comes back — `--restricted` removes it *unless `--tools` names it* |

So the model in a `local-development` session is offered no shell, no `Task`
subagent, no `WebFetch`, no `Skill`, and no MCP server (`mcp_servers: []`).
`--restricted` additionally documents that only "a person or the configured
permission handler" may approve writes to settings, git and tool-configuration
files — and with `--permission-prompts none` there is nobody to ask, so such a
write is denied automatically. That is a real and useful reduction. It is a
**permission** boundary.

### 5.2 What the flags do NOT enforce: any process boundary — verified, and the answer is "nothing"

A `SessionStart` hook is a process the runtime itself launches inside the
session it was configured with. If a kernel boundary existed, that is where it
would bite. It does not:

| Attempt, from a process the runtime launched | Result |
| --- | --- |
| write to a directory outside every `--add-dir` | **ALLOWED** — the file was created |
| write to `/tmp` | **ALLOWED** |
| read a file outside every `--add-dir` | **ALLOWED** |
| `curl https://example.com` | **ALLOWED** — HTTP 200 |

Identical results with `--restricted --permission-mode plan
--permission-prompts none` and without them. There is no sandbox to configure:
`--restricted` and `--permission-mode` decide what the *model* may ask the
*built-in tools* to do; they do not constrain a process once it exists.

Compare Codex, whose `workspaceWrite` sandbox denies exactly these writes with
`Operation not permitted` (`docs/runtime-codex.md` §4). The two runtimes are not
equivalent on this axis and the capability table must not pretend they are.

### 5.3 Does `--permission-prompts none` deny, or prompt-and-fail?

`--help` says: *"none (nobody: anything that would prompt is denied
automatically; the permission mode still decides everything else)"*. The adapter
always passes it, so an unattended run can never sit on a prompt. Whether a
specific denied tool call surfaces as a denial or as a tool error could not be
executed here: it needs a model turn to make the call. The `result` record
carries a `permission_denials` array which the adapter records verbatim; it was
always empty on this machine because no tool call ever happened.

### 5.4 The finding that changes how a project must be opened

**Without `--setting-sources ''`, a registered project's own
`.claude/settings.json` runs host commands in the worker session.**

Executed, twice, in `real-runtime.test.ts`:

| Argv | A `SessionStart` hook in the session cwd's `.claude/settings.json` |
| --- | --- |
| plain `--print --output-format stream-json …` | **RAN** |
| this adapter's argv (`--setting-sources ''`, `--restricted`) | did not run |

A repository under test is untrusted content. Opening a session in a candidate
worktree without this flag hands that repository arbitrary command execution on
the host, before the model has done anything. Both `--restricted` and
`--setting-sources ''` suppress it independently; the adapter passes both.

### 5.5 Therefore

`write_containment` is **`unsupported`** for claude-code on 2.1.260, and
`sandbox_workspace_write` is `unsupported` in
`docs/verified-capabilities.json`. `local-development` as plan §8 defines it —
"execute tools inside the verified runtime boundary" — **cannot be enforced by
this runtime**. What this adapter provides instead is:

1. a bounded tool surface (verified) with no shell and no network tool;
2. `--add-dir` scoping for the file tools, which `--help` documents and which
   §5.1 shows is real at the tool level;
3. every write recorded as a `file_change` event carrying `withinAllowedPaths`,
   so a write outside the grant is *visible* even when it is not *prevented* —
   and `runDirect` already vetoes acceptance on an observed out-of-grant write;
4. an explicit, machine-readable list of what is not enforced, on every session.

Anything stronger needs an isolated environment around the process (a container
or VM). That is an R1 gate decision for WP10, not something this adapter can
paper over.

---

## 6. Capability statuses for claude 2.1.260 on macOS

Machine-readable copy: `docs/verified-capabilities.json`.

| Capability | Status | Evidence |
| --- | --- | --- |
| `structured_events` | **verified** | real sessions produced `system/init`, `user` (including `--replay-user-messages` echoes), `assistant`, `result` and `control_response` records, all normalized; bare non-JSON stdout lines and unknown record types are preserved as `raw` |
| `session_identity` | **verified** | the uuid is minted by the adapter and passed as `--session-id`; the runtime echoes it on every record, rejects a non-uuid, and `reconcile` returns it before any turn |
| `resume_session` | supported_unverified | `--resume <id>` reuses the id in a fresh process (executed); `--fork-session` mints a new one; an unknown id yields `subtype: "error_during_execution"`. **Whether the resumed turn continues the earlier conversation needs a model turn and could not be executed here** (§9) |
| `interrupt_turn` | supported_unverified | the control round-trip is verified against the installed build (`still_queued` returned; `interrupt_cancel_queued_v1` advertised). Interrupting a *running model turn* was not executable here; the `observed`/`requested` split is covered deterministically by the recorded replay |
| `active_turn_delivery` | supported_unverified | a message written to the live process's stdin is acknowledged by the runtime (verified). Whether it joins the running turn or the next one was not observable here; the runtime's own fields describe a queue |
| `queued_delivery` | **verified** | a delivery with no active turn is held by the adapter and flushed into the next turn; the installed runtime echoed the combined frame back |
| `process_tree_stop` | **verified** | spawned as a process-group leader; stdin close → SIGTERM → SIGKILL. Executed: SIGTERM to the group ended it (exit 143) and left the group empty |
| `write_containment` | **unsupported** | §5. There is no OS sandbox. What is bounded is the tool surface, not the process |
| `model_selection` | **verified** | the `initialize` control response lists `default, opus[1m], claude-fable-5-1[1m], sonnet, haiku` with their resolved ids; `--model sonnet` was reflected in the session's `init` record as `claude-sonnet-5` |
| `effort_selection` | supported_unverified | `--effort` is accepted and the runtime lists `low, medium, high, xhigh, max` per model. An unknown value is silently ignored, so the adapter refuses one. **The runtime never reports the effective effort back**, so what took effect cannot be recorded |
| `usage_reporting` | supported_unverified | the `result` record carries `usage`, `modelUsage` and `total_cost_usd`. On this machine every turn failed authentication before reaching the provider, so only the zeros of a turn that made no API call were observed |
| `coordination_bridge` | unsupported | arrives with WP06; `--mcp-config` + `--strict-mcp-config` is the intended injection point and is not exercised here |

### Cost (FR060, AT14)

Unlike Codex, this runtime **does** report a currency figure. The adapter reports
it as `measured` only when the turn actually reached the provider
(`duration_api_ms > 0`, or any non-zero token count) and the number is finite.
Otherwise `costStatus` is `unavailable` with the reason, and `costUsd` is
`null`. A turn that dies on a local authentication failure reports
`total_cost_usd: 0` with `duration_api_ms: 0`; presenting that as a measured
zero would be exactly the lie AT14 forbids.

---

## 7. Measured timings

From `tests/adapters/claude-code/real-runtime.test.ts` on the recording machine
(warm, one sample each — observations, not performance claims):

| Measurement | Value |
| --- | --- |
| passive probe (`claude --version`) | 16 ms |
| passive probe (`--version` + `auth status`) | 150 ms |
| live probe (spawn, `initialize` control round-trip, stop) | 891 ms |
| `openSession` (spawn + `initialize` handshake) | 208–245 ms |
| `startTurn` accepted (stdin write) | < 1 ms |
| turn frame → terminal event (authentication-failure path) | 41 ms, 5 normalized events |
| `interrupt`: control request → receipt | 37 ms |
| `resumeSession` in a fresh process | 235 ms |
| `stopOwnedProcesses` (whole group) | 545 ms |
| containment probe (hook launched by the runtime) | 1 332 ms |

No timing for a turn that reaches the model: none could be run (§9).

---

## 8. Fixtures and how to run the checks

`fixtures/claude-code/fake-claude.mjs` replays a scenario so framing,
normalization, result parsing, delivery and interruption can be tested with no
network, no model turn and no quota.

It is **deterministic by construction**. WP03's replay fixture used a deferred
release, and two client frames could both be handled before the release, so the
second response was never emitted and its test flaked. Nothing here is timed:
every record the fake writes is emitted synchronously from the frame that
triggered it, and steps are consumed in file order per trigger. There is no
window in which two frames can interleave differently between runs.

| Fixture | Provenance |
| --- | --- |
| `session-auth-failure.real.json` | **recorded verbatim** from claude 2.1.260 under exactly the argv this adapter builds. Only the recording machine's home directory, scratch path, session uuid and the pid inside `messaging_socket_path` were replaced with placeholders |
| `session-hello.synthetic.json` | synthetic: a `Write` inside the granted directory, its `tool_result`, a final message, a `result` with usage |
| `session-escape.synthetic.json` | synthetic: a `Write` outside every granted directory |
| `session-claims-done.synthetic.json` | synthetic: a confident "Done." with no tool call at all |
| `session-interrupt.synthetic.json` | synthetic: the turn ends only when an interrupt control request arrives |
| `session-delivery.synthetic.json` | synthetic: a second user frame echoed back inside a still-running turn |
| `session-noise.synthetic.json` | synthetic: a bare text line, a malformed JSON line, an unknown record type, an unknown `system` subtype, an unknown content block, unknown fields on known records |
| `session-hang.synthetic.json` | synthetic: answers the handshake and then produces nothing |
| `session-no-api-call.synthetic.json` | synthetic: a `result` with `duration_api_ms: 0`, zero tokens and `total_cost_usd: 0` |

```sh
npm run typecheck
npm test                                  # deterministic; real-runtime checks are skipped

# installed runtime. The control-plane and containment blocks cost nothing;
# the model-turn block is skipped unless the CLI holds a usable credential.
WORKFORCE_REAL_RUNTIMES=1 \
WORKFORCE_CLAUDE_PATH=~/.local/bin/claude \
  npx vitest run --reporter=verbose tests/adapters/claude-code/real-runtime.test.ts

# the shared conformance suite against every adapter, real ones included
WORKFORCE_REAL_RUNTIMES=1 \
WORKFORCE_CLAUDE_PATH=~/.local/bin/claude \
WORKFORCE_CODEX_PATH=/opt/homebrew/bin/codex \
WORKFORCE_CODEX_MODEL=gpt-5.6-sol \
  npx vitest run --reporter=verbose tests/adapters/conformance
```

---

## 9. The credential state on the recording machine, and what it cost

`claude auth status` reports:

```json
{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max", …}
```

The runtime disagrees with itself. Its own `initialize` control response reports
`account: {"tokenSource": "none", "apiProvider": "firstParty"}`, `claude doctor`
prints *"Managed settings (remote): not fetched — no usable credentials"* and
*"Not signed in to claude.ai"*, and every turn ends in about 60 ms with:

```
assistant  { error: "authentication_failed", is_api_error_message: true,
             text: "Failed to authenticate: OAuth session expired and could not be refreshed" }
result     { subtype: "success", is_error: true, terminal_reason: "api_error",
             duration_api_ms: 0, total_cost_usd: 0 }
```

That is the exact transcript kept as `session-auth-failure.real.json`.

Two consequences, both recorded rather than worked around:

1. **`claude auth status` reporting `loggedIn: true` is not evidence of a usable
   credential.** The live probe now believes the runtime over the status
   command: `tokenSource: "none"` makes readiness `not_ready` with a diagnostic,
   whatever `auth status` said. That is an FR002 improvement this machine's
   state made visible.

2. **Six checks that need a completed model turn are skipped, with the reason in
   the test name**, and every capability that depends on one is
   `supported_unverified`:
   - a turn writes `hello.txt` into the granted candidate;
   - a "done" claim with no edit is an assistant message, not a success;
   - an interrupt ends a slow turn and leaves no surviving process;
   - a resumed session continues the SAME conversation;
   - a model-driven write outside the granted candidate;
   - a model-driven read outside the granted candidate.

   Re-authenticate with `claude auth login` (an interactive action) and re-run
   the gated file; the block un-skips itself by asking the runtime for its
   `tokenSource` before the tests are defined.

A skipped check is not a passing check, and none of these are counted as one.

---

## 10. Known limitations

1. **No process containment.** §5. This is the headline limitation and it gates
   FR042/FR048 for this runtime.
2. **No terminal-answer marker.** Codex marks its final message with
   `phase: "final_answer"`; Claude Code marks nothing. `claimsDone` is therefore
   always `false` with `phaseKnown: false`, and a completion claim can never be
   derived from prose. A "done" claim is an `assistant_message` and nothing more.
3. **The effective effort is never reported back.** `--effort` is accepted and an
   unknown value is silently ignored; the runtime tells us the level it used
   nowhere. The adapter records the requested value and says the effective one is
   unavailable.
4. **A malformed stdin line kills the process.** Encoding is centralised in the
   transport for exactly this reason.
5. **`init` is per turn, not per process.** A consumer that treats it as a
   session-start marker will see one per turn; the adapter emits
   `session_started` only for the first.
6. **Turn ids are the adapter's, not the runtime's.** The CLI supplies none.
   Correlation is safe only because one turn may be active per session.
7. **The default model comes from the user's configuration.** On this machine
   `claude-opus-5[1m]`. Pin a model in the agent configuration rather than
   inheriting it; the adapter records the reported model either way.
8. **`--max-budget-usd` is passed through but unproven.** No turn reached the
   provider, so no budget was ever consumed or enforced here.
9. **`--mcp-config` is not used yet.** WP06 owns the coordination bridge, and
   `coordination_bridge` stays `unsupported` until it is proved against this
   build.
10. **The user's plugins, skills and slash commands still load** unless
    `--restricted` is set (it is). Even then the built-in skills list is
    non-empty; they are not tools the model can call without the `Skill` tool,
    which the profiles do not grant.
