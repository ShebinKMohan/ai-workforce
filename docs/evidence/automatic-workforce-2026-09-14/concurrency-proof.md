# Shared workforce and concurrent project admission

The controlled local HTTP proof passed on 14 September 2026. It exercised the production request queue with actual owned Node processes, disposable project repositories, and an injected runtime-discovery record. No coding model was invoked and no user workspace was changed.

The first two project processes overlapped for **464 ms**. The maximum observed live count was **two**. A third request remained queued with no process until a worker was released, then started automatically while the other project continued.

## What was demonstrated

- Both saved workers had empty `projectIds` and default shared scope. No per-project worker assignment was made before or during execution.
- Frontend appeared first in the roster, but the API request selected the backend specialist by capability. The website request selected the frontend specialist.
- Two project requests were observed as running through the real HTTP queue and separate live process identities.
- A third project request waited while the named workers were busy. Repeating its submission returned the same request without a duplicate process.
- After the API process exited, the queued reporting request automatically reused its backend worker. The website process was still running. A worker was never reserved by two live processes.
- All three requests settled. The local proof server and its owned children stopped, and the temporary state was removed.
- Both tracked dirty content and untracked files remained byte-identical in all three disposable repositories. HEAD and Git status were unchanged. The saved workforce configuration was also unchanged.

## Proof boundary

This verifies HTTP admission, capability selection, cross-project process concurrency, duplicate suppression, worker ownership, and automatic queue release. It does **not** establish a coding model's task understanding, actual source implementation, verifier acceptance, or a runtime's containment capability.

The discover callback supplies clearly labeled, known-version Codex metadata to exercise the nonexclusive admission branch. The injected spawner records the exact production CLI argument array, then launches a controlled Node process instead of Codex. This is a deliberate deterministic test seam, matching the queue regression tests. Runtime discovery does not probe the host or read credentials.

The separate real Codex codebase-analysis record establishes a different proof layer.

## Retained artifacts

- `concurrency-proof.ts`: repeatable standalone proof using the current production source; creates and removes its own repositories and state.
- `concurrency-receipts.json`: successful HTTP request snapshots, exact intended CLI arguments, process timestamps, source/config fingerprints, assertions, and cleanup receipts.
- `concurrency-attempt-1-url-error.json`: first harness attempt used a doubled URL separator, receiving a 405 before spawning. The harness now uses the URL origin.
- `concurrency-attempt-2-unconfined-fixture.json`: using the fake adapter correctly failed the production containment admission gate. The final controlled fixture explicitly injects discovery metadata for the nonexclusive branch; it does not weaken that production gate.
