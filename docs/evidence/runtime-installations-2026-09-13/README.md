# Installed runtime catalogs, 2026-09-13

The missing GPT-6 Astra entry came from using a different installed Codex executable. Claude's missing version names came from dropping model resolution metadata in the catalog normalization layer. Neither fix adds a model name to the harness source.

## Passive observations

| Exact executable | Reported CLI version | Native metadata result |
| --- | --- | --- |
| `/opt/homebrew/bin/codex` | `0.147.0` | Five visible models; GPT-5.6 Sol is the reported default. No Astra. |
| `/Applications/ChatGPT.app/Contents/Resources/codex` | `0.154.0-alpha.6.2` | Six visible models; GPT-6 Astra is the reported default. Astra reports low, medium, high, xhigh, max, ultra efforts and text/image inputs. |
| `/opt/homebrew/bin/claude` | `2.1.236` | Five selectable entries with exact `resolvedModel` identities. |
| `/Users/shebin_mohan_k/.local/bin/claude` | `2.1.260` | The same five selectable entries and resolutions in this observation. |

The two Codex processes used the same `workforce` / `0.1.0` initialize identity and inherited environment. Both documented `login status` commands reported a ChatGPT login. Including hidden models yielded seven entries for Homebrew and eight for the desktop executable; neither exposed an extra page (`nextCursor: null`). The hidden entries were Reserve and Auto Review. Astra was a normal visible entry only in the desktop executable. This excludes hidden filtering, missing pagination and a special desktop client identity as explanations for this comparison.

No conversation or model turn was started for this catalog investigation. Each isolated Codex comparison process exited and its process group was observed absent. The normalized production discovery path likewise accepts metadata only after confirming its owned subprocess stopped. No credentials, account fields or login output are stored in these artifacts.

Claude returned these resolutions itself:

| Accepted selector value | Runtime-reported resolution | Versioned name from its description |
| --- | --- | --- |
| `default` | `claude-opus-5[1m]` | Opus 5 with 1M context |
| `opus[1m]` | `claude-opus-5[1m]` | Opus 5 with 1M context |
| `claude-fable-5-1[1m]` | `claude-fable-5-1` | Fable 5.1 |
| `sonnet` | `claude-sonnet-5` | Sonnet 5 |
| `haiku` | `claude-haiku-4-5-20251001` | Haiku 4.5 |

The accepted selector remains unchanged during execution. In particular, Fable's selectable value includes `[1m]` while the reported resolved identity does not. Replacing aliases with resolved identities would lose this distinction. Haiku did not report effort choices; the harness leaves them unavailable. No default effort or Claude default model is inferred from an alias name.

## Changes and API contract

- Bounded known locations now include the Codex executable in `Codex.app` and `ChatGPT.app` resources under `/Applications` and `~/Applications`. Discovery still checks exact executable paths, without recursive disk scans. The existing PATH or explicit binding retains priority.
- `GET /api/workspace?refresh=1` already performs fresh passive discovery. `runtimes.reports[].installations` now exposes each discovered `{path, realPath, source, origins, selected}`. Registering another installation remains an explicit workspace `runtime.set` operation; discovered paths are not automatically assigned to employees.
- `GET /api/runtimes/:id/models?refresh=1` reports only models from that binding's selected executable. It exposes `source`, `installations`, executable paths, CLI version and observation time. Alternate installations are described as alternate bindings, never merged into its model list.
- Each normalized model retains `id`, `label`, `runtimeLabel`, `resolvedModel` and `catalogId` when reported, plus `provenance: runtime-reported`. Claude labels use the versioned prefix of the runtime's own description, with exact resolution fallback. Effort and input capability choices remain runtime reported.

`codex-comparison.json` records the native visible/hidden comparison. `normalized-catalogs.json` records the new production normalization against all four exact paths above. `probe-codex.mjs` repeats the metadata-only comparison for executable paths supplied on its command line.

## Verification and limits

Type checking and 44 focused tests passed, covering exact executable binding, separate catalogs for different installations, discoverable desktop paths outside PATH, metadata refresh, Claude alias identity retention, unknown efforts, sanitized errors, pagination and subprocess cleanup. Live inference and write containment are separate capabilities; these passive catalog observations do not establish them for a new CLI version. Existing prior capability evidence is unchanged. Catalog contents are account, installation and time specific and must be refreshed from the installed runtime.

## Subsequent exact-build conformance

The desktop executable was then tested separately because its previously unrecorded file boundary correctly prevented Control Center admission. Its SHA-256 was `ecad78dbf98adb89ec475edac86630406cbe59d9f3070b17d88065f136b94bcb` and its reported version was `0.154.0-alpha.6.2` on Darwin.

- `codex-desktop-conformance.txt`: four selected native checks passed. Native settings, actual thread identity/effective settings, error lifecycle controls, owned process stop, permitted writes and denied outside/read-only writes were exercised.
- `codex-desktop-network-boundary.txt`: strengthened boundary test passed. A reachable, test-owned local HTTP listener accepted an unsandboxed positive control. Sandboxed commands under both `analysis` and `local-development` could not contact it; its request count remained one. This avoids mistaking public network or DNS failure for sandbox enforcement.
- `codex-desktop-model-conformance.txt`: six real model checks passed: streamed file creation, active steering, resume retaining conversation history, observed interruption with cleanup, unchanged outside files following a model-driven request, and a done-without-change response remaining unaccepted. These model tests used runtime-reported GPT-5.6 Sol with low effort; Astra inference is a separate UI check.
- The same model suite's MCP check failed before its stored-message assertion because it expected an old elicitation event. A stricter receipt-first isolated retry also failed: zero coordinator messages were recorded. Those failed runs did not establish coordination. Both failures are retained in their artifacts. `codex-desktop-mcp-retry.txt` contains the retry. At that stage no new-build MCP capability was marked verified; the subsequent fix and positive proof are recorded below.

The adapter now retains its original `testedVersion` baseline and records additional exact `testedVersions` separately per capability. A shared helper matches both exact version and OS across run admission, Control Center admission/exclusivity, and recovery. Executions record the matching build in their own containment assessment. Adjacent prereleases, the later release, unknown versions, unsupported boundaries and other operating systems do not inherit this evidence. Discovery overrides likewise support `exactVersions` and `os`; the new record does not cover a version range.

Type checking, 80 focused tests across five files, and diff checking passed after these changes. The tests cover the retained baseline, separately tested build, unknown and adjacent-build refusal, OS isolation, Control Center admission without unnecessary consent, and recovery onto an independently tested build. The new build's write boundary and session controls can support Discussion independently of its unverified coordination capability. No consent flag was automatically enabled and no unconfined-write gate was bypassed.

## Scoped coordination compatibility fix

The native metadata comparison in `codex-mcp-metadata-comparison.json` showed that both Codex builds connected the bridge and exposed its six worker tools. The diagnostic model turn then supplied the concrete error: `MCP tool call requires approval, but approval policy is never`. Version 0.154 rejected the call before the older elicitation handler could authorize the coordinator's own channel. This was not a tool schema failure.

The coordinator now supplies `mcp_servers.workforce.enabled_tools` for the session's exact role and `mcp_servers.workforce.tools.<tool>.approval_mode="approve"` for each of those names. Workers receive their six defined coordination tools; heads receive only `workforce_propose_plan`; reviewers receive only `workforce_review_result`. The global `approvalPolicy: never`, file/network sandbox, every other MCP server, and the coordinator's token/role checks remain unchanged. No server-wide default or wildcard permission is added. This is the documented [per-tool MCP configuration](https://developers.openai.com/codex/mcp), whose behavior is also visible in [OpenAI's MCP approval implementation](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/mcp/mod.rs).

Both installed binaries recognized the scoped setting in a no-token parser check and rejected invalid enum values at that exact key. After the fix, `codex-desktop-mcp-verified.txt` passed every acceptance assertion: exactly one stored message from the expected task, exact canonical body `{text:"schema is ready"}`, a completed result from the provisioned `workforce/send_message` tool without an error, and an assistant reply containing the stored message ID. No elicitation was emitted. The additional exact-build coordination capability is recorded only after that successful proof. The earlier fixed-run artifact's body assertion failure was a test expectation error: coordinator storage intentionally normalizes string message bodies into `{text:...}`.

The same strict coordination check also passed on Homebrew 0.147.0 after the fix; `codex-homebrew-mcp-fixed.txt` records its exact stored row, completed provisioned tool, matching returned ID and zero elicitations. The original Homebrew binding retains its separately recorded capability evidence.

The targeted bridge, role authorization and RPC suite passed 51 tests across three files, including refusal of unprovisioned servers, unknown tools, credential requests, unrelated permission requests and role-token forgery. A final adapter, exact-build capability, role and RPC regression run passed 92 tests across six files with type checking and diff checking clean.
