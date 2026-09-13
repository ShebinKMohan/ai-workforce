# Runtime model selection and AI Control Center — 13 September 2026

Verified in the local desktop app at `127.0.0.1:4421`, using the saved AI Employee project.

- The installed Codex 0.147.0 catalog lists Sol, Terra, Luna, GPT-5.5 and Spark. Astra is not reported by this CLI. Per-model efforts change when the selected model changes (Sol includes ultra; GPT-5.5 ends at xhigh).
- Claude Code 2.1.236 also supplied its passive model catalog. Opus effort choices became available after selecting its reported alias. Haiku has no reported effort choices. Catalog availability does not establish Claude execution compatibility.
- The browser composer sent a workspace question with explicit Codex / GPT-5.5 / low. The durable request recorded original and resolved settings separately from runtime defaults. The effective runtime receipt reported GPT-5.5 / low and a stopped owned session.
- Control Center returned an actual AI reply naming Engineering, Sales and Finance. It created no worker run (`runId: null`, `workerIds: []`). Intake including runtime startup and process settlement measured 10.36 seconds; this is not instant routing.
- Settings showed dynamic model/effort controls for runtime defaults and Control Center. No saved configuration was changed by the visual check.

Artifacts: `chat-control-reply.png`, `control-reply-receipt.json`, and the two installed-runtime catalog JSON files. Metadata discovery starts no paid model turn. The chat question above did use one bounded Codex turn.

Validation at this stage: full suite 1,494 passed / 32 skipped. Subsequent attachment, picker and scene work is documented separately and must not be inferred from these results.
