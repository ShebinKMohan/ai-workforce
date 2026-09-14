PRD: Correct numeric addition in the disposable math project.

Problem: add(2, 3) currently returns -1 instead of 5.

Implement now with exactly one Engineering worker. Fix only src/math.mjs so add(a, b) returns the numeric sum for the existing supported numbers. Preserve the original test/ files, package.json and repository instructions. No installation, network calls, subagents, commits, pushes, merges or deployment.

Acceptance: the existing command node --test test/math.test.mjs passes for positive integers, mixed-sign integers and decimal values. The coordinator must independently run the existing checks against its frozen candidate and the Engineering head must review that candidate. Return a verified local candidate only; do not apply it to the original repository.

Preserve this original PRD's line breaks and wording — including this evidence marker: MCP-PRD-2026-09-13.
