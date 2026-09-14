# MCP connections

Open **AI Workforce** from your Applications folder, then choose **Connections**.
The app automatically checks for Codex and Claude Code on your Mac.

1. Click **Connect installed agents** to connect detected tools together, or **Connect** beside one agent.
2. Wait for **Connection ready**. The app saves the connection, reads it back and checks that
   the Workforce tools can reach your current workspace.
3. Reopen your coding agent if it was already running, so it loads the new connection.

No terminal command, copied configuration, provider token or manually entered path is needed
for the detected installations. **Scan again** refreshes detection. **Repair connection** updates a saved connection after the local service moves. **Check connection** tests
an existing connection. The app does not replace an unrelated connection with the same name.
If setup cannot finish, the card explains the problem and keeps its retry action available.

The MCP status panel shows the bridge identity, transport, and verified tools. Each agent has separate **Setup saved** and **Tools verified** indicators. **MCP · 2 ready** means two saved clients passed the check; it does not mean two external chats are currently connected. The advanced details show the local service address and the time of the last check.

## Send a plan

Finish planning in Codex or Claude, then ask it naturally:

> Send this complete plan to AI Workforce for my project and start the team working on it.

The coding agent can find the saved project and preserve the full plan. You do not need to
copy a tool name, project ID or submission key yourself. The connection's tool definitions guide
the coding agent through those details and reuse the original submission when retrying.

For work you want to keep for later, ask the coding agent to save the plan without starting it.
It appears on **Issues** in Backlog. Use **Send to Control Center** whenever you are ready.

## Prepare the project once

In **Projects**, choose **Add project**, browse to its folder, and save the project.
Your existing active team can work across registered projects automatically. Specialists are
selected by capability and availability, with optional project restrictions in advanced agent
settings. Different projects can run at the same time within your saved capacity. Read-only
codebase explanations do not require configured test commands.

The issue moves with recorded work: Control Center chooses a department, its head plans and
assigns the work, the workers implement, and independent checks plus head review support the
result. Open the issue's task to read that evidence. A manually completed card is labeled
separately from a verified candidate.

## What the connection check proves

**Connection ready** means the installed coding-agent configuration points to this Workforce
workspace and the bridge's tools answered successfully. An existing Codex or Claude conversation
may still need to be reopened. Setup itself does not start a model task.

A completed coding task is a separate check. The [real execution proof](evidence/issues-mcp-2026-09-13/README.md)
records an external PRD submission completed by Codex, with preserved source and verified review.

Technical protocol details, portable configurations and terminal troubleshooting remain in the
optional [MCP technical reference](mcp-reference.md).
