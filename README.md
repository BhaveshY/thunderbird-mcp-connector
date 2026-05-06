# Thunderbird MCP Connector

Local connector for using Thunderbird with Claude through MCP on macOS and Windows, with a CLI-first path that also works on Linux.

The connector has three pieces:

- a Thunderbird MailExtension in `addon/`
- a native host and local broker in `host/`
- a stdio MCP server exposed by `thunderbird-mcp mcp`

The v1 safety boundary is deliberate: Claude can read messages you ask for and create drafts, but the connector does not request permission to send email.

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
