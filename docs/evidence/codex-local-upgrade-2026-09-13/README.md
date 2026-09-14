# Official local Codex CLI upgrade, 13 September 2026

The user requested one local Codex harness binding, an updated local CLI, and removal of the duplicate desktop binding. Removing the binding does not uninstall the Codex desktop application.

## Installation and update

`/opt/homebrew/bin/codex` was version 0.147.0. Despite that prefix, the executable was owned by the global npm package, not Homebrew: its symlink resolves to `/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js`; `npm list --global @openai/codex` reported 0.147.0; Homebrew's Codex cask reported `installed: null`.

Official npm metadata, the latest OpenAI GitHub release, and Homebrew's OpenAI-backed cask metadata all reported stable 0.154.0 on this date:

- https://registry.npmjs.org/@openai/codex/latest
- https://api.github.com/repos/openai/codex/releases/latest
- https://formulae.brew.sh/api/cask/codex.json

The existing installation was updated with:

```sh
npm install --global @openai/codex@0.154.0 --registry=https://registry.npmjs.org --ignore-scripts
```

It exited zero, changing two packages. `/opt/homebrew/bin/codex --version` then reported `codex-cli 0.154.0`; the documented `login status` command still reported ChatGPT login. No authentication/configuration files were read or changed, and no application was uninstalled. No running process from this global installation was present before the update; other installed application runtime processes were preserved.

## Native discovery

`catalog.json` records the catalog returned by this exact upgraded binding. It reports `gpt-6-astra` as the default, followed by Sol, Terra, Luna, GPT-5.5 and Spark. Astra offers low, medium, high, xhigh, max and ultra, with text and image inputs. These values come from native `model/list`; they are not copied from the desktop catalog or fabricated from a subscription assumption.

Discovery and execution use the same configured `/opt/homebrew/bin/codex` launcher. The stable native binary lives at `@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex` under the global npm root, with SHA256 `4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc`.

## Exact-build conformance

`conformance.txt` contains the full real-runtime run and independent provenance. All **12 tests passed with zero skips or failures** in 150.18 seconds against the exact upgraded launcher. The checks established structured events, owned sessions and process cleanup, active steering, resume/history, real file creation, explicit filesystem and network boundaries, token usage, and a real coordinator MCP message with a matching stored ID. The global approval policy stayed `never`; only the provisioned role's exact tools were preauthorized.

The native command boundary check actually attempted forbidden writes. Its network control first reached an owned local HTTP listener outside the sandbox, then established that neither sandbox profile could contact it. The separate model-driven outside-write check establishes unchanged files and a visible refusal; that refusal may be assistant-only.

Live model turns in this suite used Sol/low. Astra availability is established by native discovery here; a completed Astra conversation through the running product is a separate UI/runtime proof owned by the main task. Queued delivery and live head/reviewer tool calls were not separately tested and do not inherit new-version evidence.

`docs/verified-capabilities.json` registers only this exact stable version on macOS. The adapter's per-capability exact-version registry preserves the separately verified 0.147.0 and desktop 0.154.0-alpha.6.2 builds; adjacent versions and other operating systems remain unverified.

## Binding consolidation

The new `runtime.remove` operation removes only an unused workspace binding. It refuses references from Control Center and any agent, including archived agents. Current references can be migrated in one compare-and-swap operation batch before removal. Durable request/run receipts retain their original runtime IDs and executable metadata. Source changes, CLI installation, a catalog, and conformance do not by themselves establish that the running server has reloaded or that the workspace migration has occurred; those are recorded separately by the main task.
