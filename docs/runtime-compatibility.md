# Runtime compatibility

Scope: WP02 — discovery (FR001, FR002, FR005, FR006, FR013).
Recorded: 7 September 2026 on the development machine described below.

This file records what discovery actually observed. Everything here is a
measurement or a documented interface, never a claim that an adapter works: no
runtime session has been opened yet, so no capability is `verified`.

## Host and tested versions

| Item | Value |
| --- | --- |
| Platform | macOS (darwin 25.6.0), Apple Silicon |
| Node.js | v26.8.1 (`node:sqlite` built in) |
| Codex CLI | `codex-cli 0.147.0`, `/opt/homebrew/bin/codex` -> `/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js` |
| Claude Code | `2.1.260 (Claude Code)`, `~/.local/bin/claude` -> `~/.local/share/claude/versions/2.1.260` |

Adapter version gates: Codex >= 0.140.0, Claude Code >= 2.1.0. Below the gate
every capability is `unsupported`, so an execution mode that needs one of the
required controls is blocked rather than attempted.

## How discovery finds an executable (FR001)

Search order, and nothing else is inspected:

1. the explicit path from `--codex-path` / `--claude-path`;
2. every `PATH` entry, in order;
3. `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.codex/bin`, `~/.npm-global/bin`.

Only the exact executable name is stat'ed in each directory — no directory is
walked and no disk is scanned. Every match is reported with its real path
(symlinks resolved) and exactly one is marked selected. An explicit path that is
not an executable file selects nothing and says so; it never falls back to a
different installation, because that would silently ignore what the user asked
for.

## How a probe is bounded (FR002)

| Property | Value |
| --- | --- |
| Spawn | `spawn(executable, argsArray, { shell: false })`, own process group |
| Working directory | a fresh `mkdtemp` directory, removed afterwards — no repository configuration or hook can influence a probe |
| stdin | closed, so a probe can never be handed input or block on a prompt |
| Environment | allowlist only: `HOME PATH USER LOGNAME SHELL LANG LC_ALL TMPDIR`, plus `TERM=dumb NO_COLOR=1`. No provider credentials are forwarded |
| Deadline | 10 s per probe; on timeout `SIGTERM` then `SIGKILL` to the whole process group (there is no `gtimeout` on this machine; the deadline is implemented in Node) |
| Output | capped at 256 KiB per stream |

The only argument lists passive discovery may run are fixed in code and checked
before every spawn (`assertDocumentedProbeArgv`):

| Adapter | Version probe | Login probe |
| --- | --- | --- |
| `codex` | `codex --version` | `codex login status` |
| `claude-code` | `claude --version` | `claude auth status` |

Anything else throws before a process starts. That is what makes "passive
discovery never starts a paid model turn" a property of the code rather than a
convention.

### Version and login formats observed

| Adapter | Version line | Login output |
| --- | --- | --- |
| `codex` 0.147.0 | `codex-cli 0.147.0` | `Logged in using ChatGPT` (exit 0) |
| `claude-code` 2.1.260 | `2.1.260 (Claude Code)` | JSON by default: `{"loggedIn": true, ...}`; `--text` prints a status line |

`claude auth status` also prints the account email, organisation and
subscription type. None of that is read into the report: only the `loggedIn`
boolean is extracted, and the raw login output is never stored.

A timeout or a non-zero exit maps authentication to `unknown`, never to a ready
state. `unknown` is deliberately less informative than guessing "logged out"
from a failure — a failed probe establishes nothing.

## Readiness levels (FR002)

| Level | Meaning |
| --- | --- |
| `missing` | no executable found (or the explicit path is wrong) |
| `installed` | found, but the version is below the adapter minimum, or no version could be read |
| `adapter_supported` | version gate passed, but a required control capability is `unsupported` |
| `controllable` | required controls present and the login state was read (`logged_in` or `logged_out`) |
| `auth_unknown` | required controls present, but the login state could not be established |
| `verified_ready` | set only by an explicit live check; passive discovery can never produce it |

Required controls: `structured_execution`, `owned_session_identity`,
`observed_cancellation` (plan section 6, R0 gate).

## Capability table

Statuses default to `supported_unverified`: the interface is documented for that
version range but has not been proved against the installed executable. Only a
real adapter test (WP03/WP05) may raise an entry to `verified`, and it does so by
writing `docs/verified-capabilities.json`, which discovery loads when present:

```json
{
  "version": 1,
  "entries": [
    {
      "adapter": "codex",
      "minVersion": "0.147.0",
      "maxVersionExclusive": "0.148.0",
      "capabilities": {
        "observed_cancellation": {
          "status": "verified",
          "evidence": "WP03 adapter test <id>: process-tree termination observed"
        }
      }
    }
  ]
}
```

`evidence` is required, so a `verified` claim always names what established it. A
malformed file is reported and ignored rather than failing `doctor`.

The file is present and carries WP03's codex evidence, bound to `0.147.0` alone
(`maxVersionExclusive: "0.147.1"`), so a later build falls back to the
documented-but-unproved table instead of inheriting the claim. WP03's adapter
uses its own capability names, and this file is where they are mapped onto the
discovery names above:

| Discovery name | Established by (WP03 adapter capability) |
| --- | --- |
| `structured_execution` | `structured_events` |
| `owned_session_identity` | `session_identity` |
| `observed_cancellation` | `interrupt_turn` and `process_tree_stop` together |
| `resume_session` | `resume_session` |
| `active_turn_delivery` | `active_turn_delivery` and `queued_delivery` |
| `sandbox_workspace_write` | `write_containment` |
| `model_selection` | `model_selection` |
| `effort_selection` | `effort_selection` |
| `token_usage_report` | `usage_reporting` (token counts only) |
| `cost_report` | `usage_reporting` currency detail — `unsupported` |

`mcp_config_injection` is deliberately absent: WP03 proved nothing about it, so
it stays `supported_unverified`. `tests/integration/wiring.test.ts` fails if the
shipped file stops parsing or stops raising these statuses.

`cost_report` is `unsupported` for both adapters: no currency-cost field is
established here, and an unavailable cost must not be reported as zero.

## Settings and policy translation (FR006, FR013)

| Setting | `codex` 0.147.0 | `claude-code` 2.1.260 |
| --- | --- | --- |
| effort | `minimal, low, medium, high, xhigh` via `-c model_reasoning_effort="<v>"` | `low, medium, high, xhigh, max` via `--effort <v>` |
| model | `--model <v>`; unknown values are `accepted_unverified` and passed through unchanged | same |
| tool allow/deny | **unsupported** — no documented per-tool list; the sandbox mode and approval policy are the enforcement surface | `--allowedTools` / `--disallowedTools` |
| extra directories | `--add-dir <dir>` | `--add-dir <dir>` |
| MCP injection | `-c mcp_servers=...` (`accepted_unverified` until WP06 proves it) | `--mcp-config <file>` (same) |
| permission control | `--sandbox read-only\|workspace-write` and `--ask-for-approval untrusted\|on-request\|never` | `--permission-mode acceptEdits\|auto\|manual\|dontAsk\|plan` |

An effort level belonging to the other runtime is **rejected**, never mapped:
`max` is not accepted by Codex and `minimal` is not accepted by Claude Code.
`--sandbox danger-full-access` and `--permission-mode bypassPermissions` are
rejected because they remove the containment boundary.

Policy profiles translate to:

| Profile | `codex` | `claude-code` |
| --- | --- | --- |
| `analysis` | `--sandbox read-only --ask-for-approval never` | `--permission-mode plan --disallowedTools Edit Write NotebookEdit` |
| `local-development` | `--sandbox workspace-write --ask-for-approval never [--add-dir <candidate>]` | `--permission-mode acceptEdits [--add-dir <candidate>]` |
| `verification` | `--sandbox workspace-write --ask-for-approval never` against a disposable copy of the frozen candidate | `--permission-mode plan --disallowedTools Edit Write NotebookEdit` |

Parts of a profile that **no adapter flag can enforce** are reported as
`unsupported` rather than pretended:

- `permissions.network` — neither CLI exposes a documented flag that enforces a
  worker-tool network policy; the execution environment must.
- `permissions.externalDelivery` — nothing stops a worker attempting a push; the
  coordinator denies delivery by withholding credentials and remotes.
- `permissions.executeRepositoryHooks` — the `analysis` profile forbids running
  repository hooks with host privileges; the check runner must enforce that.
- `permissions.sandbox` on Claude Code — file access is bounded by the permission
  mode and `--add-dir`, not by an OS sandbox, so containment is established
  outside the adapter.

## `workforce doctor` on this machine

Doctor is informational: it exits 0 even when a runtime is missing, and exits 2
only for invalid arguments.

```console
$ workforce doctor
workforce doctor — passive runtime discovery (no model turn is started)
state root: /tmp/workforce-doctor-demo

RUNTIME      VERSION  READINESS     AUTH       EXECUTABLE
codex        0.147.0  controllable  logged_in  /opt/homebrew/bin/codex
claude-code  2.1.260  controllable  logged_in  /Users/shebin_mohan_k/.local/bin/claude

codex — Codex CLI
  readiness:     controllable (passive discovery; verified_ready needs a live check)
  executable:    /opt/homebrew/bin/codex
  real path:     /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js
  version:       0.147.0 (adapter minimum 0.140.0)
  authentication: logged_in — `codex login status` reports an active login
  capabilities:
    structured_execution     supported_unverified — app-server / `codex exec --json` emit structured events
    owned_session_identity   supported_unverified — sessions are addressed by id and can be resumed
    observed_cancellation    supported_unverified — interruption is requested through the app server; observed termination still needs the process group
    resume_session           supported_unverified — documented for this version range; not yet proved against the installed executable
    active_turn_delivery     supported_unverified — documented for this version range; not yet proved against the installed executable
    mcp_config_injection     supported_unverified — MCP servers are configured through `-c mcp_servers...`
    sandbox_workspace_write  supported_unverified — `--sandbox workspace-write` is documented on this version
    model_selection          supported_unverified — documented for this version range; not yet proved against the installed executable
    effort_selection         supported_unverified — effort is set through the `model_reasoning_effort` configuration value, not a flag
    token_usage_report       supported_unverified — documented for this version range; not yet proved against the installed executable
    cost_report              unsupported — no currency-cost field is established for this runtime; report cost as unavailable, never as zero
  probes:
    /opt/homebrew/bin/codex --version — exit 0, 45 ms
    /opt/homebrew/bin/codex login status — exit 0, 50 ms

claude-code — Claude Code
  readiness:     controllable (passive discovery; verified_ready needs a live check)
  executable:    /Users/shebin_mohan_k/.local/bin/claude
  real path:     /Users/shebin_mohan_k/.local/share/claude/versions/2.1.260
  version:       2.1.260 (adapter minimum 2.1.0)
  authentication: logged_in — `claude auth status` reported loggedIn=true
  capabilities:
    structured_execution     supported_unverified — `--print --output-format stream-json` emits structured events and a result record
    owned_session_identity   supported_unverified — sessions carry an id that `--resume` accepts
    observed_cancellation    supported_unverified — the process can be interrupted; observed termination still needs the process group
    resume_session           supported_unverified — documented for this version range; not yet proved against the installed executable
    active_turn_delivery     supported_unverified — documented for this version range; not yet proved against the installed executable
    mcp_config_injection     supported_unverified — MCP servers are configured through `--mcp-config`
    sandbox_workspace_write  supported_unverified — write scope is bounded by `--add-dir` and the permission mode, not by an OS sandbox
    model_selection          supported_unverified — documented for this version range; not yet proved against the installed executable
    effort_selection         supported_unverified — `--effort` accepts low, medium, high, xhigh and max on this version
    token_usage_report       supported_unverified — documented for this version range; not yet proved against the installed executable
    cost_report              unsupported — no currency-cost field is established for this runtime; report cost as unavailable, never as zero
  probes:
    /Users/shebin_mohan_k/.local/bin/claude --version — exit 0, 14 ms
    /Users/shebin_mohan_k/.local/bin/claude auth status — exit 0, 159 ms
```

Exit codes observed:

```console
$ workforce doctor ; echo "exit=$?"
exit=0

$ workforce doctor --codex-path /nope/codex --claude-path /nope/claude ; echo "exit=$?"
RUNTIME      VERSION  READINESS  AUTH     EXECUTABLE
codex        -        missing    unknown  (not found)
claude-code  -        missing    unknown  (not found)
exit=0

$ workforce doctor --codex-path "" ; echo "exit=$?"
error: --codex-path needs a path to the executable
exit=2
```

`--json` prints one machine-readable document on stdout. The per-runtime record
observed here:

```json
[
  {
    "adapter": "codex",
    "executable": "/opt/homebrew/bin/codex",
    "realPath": "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js",
    "version": "0.147.0",
    "installed": true,
    "adapterSupported": true,
    "controllable": true,
    "auth": "logged_in",
    "readiness": "controllable",
    "probeKind": "passive",
    "checkedAt": "2026-09-07T06:39:24.609Z",
    "probes": [
      "/opt/homebrew/bin/codex --version -> exit 0",
      "/opt/homebrew/bin/codex login status -> exit 0"
    ]
  },
  {
    "adapter": "claude-code",
    "executable": "/Users/shebin_mohan_k/.local/bin/claude",
    "realPath": "/Users/shebin_mohan_k/.local/share/claude/versions/2.1.260",
    "version": "2.1.260",
    "installed": true,
    "adapterSupported": true,
    "controllable": true,
    "auth": "logged_in",
    "readiness": "controllable",
    "probeKind": "passive",
    "checkedAt": "2026-09-07T06:39:24.812Z",
    "probes": [
      "/Users/shebin_mohan_k/.local/bin/claude --version -> exit 0",
      "/Users/shebin_mohan_k/.local/bin/claude auth status -> exit 0"
    ]
  }
]
```

With `--agents fixtures/agents/example.json`, doctor also validates each
configured binding against the discovered version and prints the controls a
policy becomes, plus what it cannot enforce:

```console
  agent engineer: runtime claude-local (claude-code via claude), policy local-development
    policy controls: --permission-mode acceptEdits
    unsupported permissions.sandbox: Claude Code bounds file access with the permission mode and --add-dir; ...
    unsupported permissions.network: no documented claude-code flag enforces the "project_allowlist" worker-tool network policy; ...
    unsupported permissions.externalDelivery: no adapter control prevents a worker from attempting a push or deployment; ...
  agent architect: runtime codex-local (codex via codex), policy analysis
    policy controls: --sandbox read-only --ask-for-approval never
    unsupported permissions.network: ...
    unsupported permissions.executeRepositoryHooks: the analysis profile forbids running repository hooks with host privileges; ...
```

## Limitations recorded at WP02

- No runtime session has been opened. Every capability is `supported_unverified`
  or `unsupported`; nothing is `verified`, and no runtime is `verified_ready`.
- Codex effort values (`minimal`…`xhigh`) come from the documented
  `model_reasoning_effort` setting, not from a `--help` enumeration on 0.147.0;
  they are validated as a fixed set and never mapped.
- Codex approval policies observed on 0.147.0 are `untrusted`, `on-request`,
  `never`. An older `on-failure` value is not accepted by this version.
- A non-zero exit from a login-status command yields `unknown` rather than
  `logged_out`, even when the output looks like a logged-out message.
- Discovery has been exercised on macOS only. Windows/Linux path handling,
  process-group termination and the known locations are untested.
