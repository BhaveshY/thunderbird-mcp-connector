# Thunderbird MCP Connector

Local connector for using Thunderbird with Claude through MCP on macOS and Windows, with a CLI-first path that also works on Linux.

The connector has three pieces:

- a Thunderbird MailExtension in `addon/`
- a native host and local broker in `host/`
- a stdio MCP server exposed by `thunderbird-mcp mcp`

The connector reads mail only through Thunderbird's local MailExtension APIs.
It can create drafts and organize messages with Thunderbird's own permissions.
Autonomous replies use `preview_reply` followed by a content-bound, persistently
idempotent `send_reply`; uncertain outcomes must be resolved with
`reconcile_send`. General compose sends still require explicit confirmation.
Search tools are optimized for old mailboxes: compact results by default,
paged continuation tokens for deep searches, and concurrent attachment
inspection for attachment-heavy folders.

See [docs/INSTALL.md](docs/INSTALL.md) and [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

For agent-driven installs, follow [docs/INSTALL.md](docs/INSTALL.md) end to
end and keep [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) open. The most
common failures are an add-on XPI built with Windows backslash paths, a native
host that was registered before `npm run build`, and Claude Desktop JSON saved
with a UTF-8 BOM.

For a non-coding Windows user, paste this repository link into Claude Code and
ask the agent to follow [docs/AGENT_WINDOWS_INSTALL.md](docs/AGENT_WINDOWS_INSTALL.md).
The one-shot entrypoint is:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```
