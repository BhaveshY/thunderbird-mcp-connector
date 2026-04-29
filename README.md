# Thunderbird MCP Connector

Local connector for using Thunderbird with Claude through MCP on macOS and Windows, with a CLI-first path that also works on Linux.

The connector has three pieces:

- a Thunderbird MailExtension in `addon/`
- a native host and local broker in `host/`
- a stdio MCP server exposed by `thunderbird-mcp mcp`

The v1 safety boundary is deliberate: Claude can read messages you ask for and create drafts, but the connector does not request permission to send email.

See [docs/INSTALL.md](docs/INSTALL.md) and [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).
