# Single-script startup — 14 September 2026

The canonical source is `/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee`.
Frontend files are in `web/headquarters`; backend files are in `src`. The old
`Documents/ChatGPT` directory does not exist. Saved workspace data remains outside the source
checkout, selected by `.workforce-local.json`.

`run.sh` starts the complete app. `Run Workforce.command` invokes the same script and can be
double-clicked in Finder. Both are executable. The shared launcher detects a supported Node,
checks direct dependencies against the lock file, builds the backend and local frontend assets
on a cold start, and returns only after verifying the server's source and workspace identities.
The script opens that URL by default. The detached server keeps running when the script exits.

## Live verification

[live-proof.json](live-proof.json) records a real cold start through `run.sh`, from `/private/tmp`
with only `/usr/bin:/bin` in PATH, using this source checkout and a temporary empty data folder.
The actual backend compiler and frontend Motion build completed. The frontend, bundled Motion
asset and workspace API all returned HTTP 200. A second launch through `Run Workforce.command`
reused the same server PID. Only that temporary test server was stopped afterward; its data
folder was removed. No coding-agent request was submitted.

The original workspace on port 4421 kept PID 12083 throughout the check. Launching `run.sh`
against the saved local settings, from outside the repository with the same minimal PATH,
successfully reused that workspace and its existing data folder.

Browser opening was disabled for the isolated live test. The readiness-before-open and
no-open behavior are checked separately in the focused launcher tests. Dependencies were
already installed for this live test; it does not claim a fresh dependency download.

## Automated checks

Shell syntax checks passed for both root launchers. `npm run test:launcher` passed all 12 tests
with zero failures or skips. Coverage includes workspace identity,
safe repeated/concurrent startup, backend and frontend builds, partial dependency detection,
script paths containing spaces and browser-opening behavior.
