# Install and Test

This connector has three required pieces:

1. the Node MCP server, run as `thunderbird-mcp mcp`;
2. the Thunderbird native messaging host, registered for the current user;
3. the Thunderbird add-on, installed and enabled inside Thunderbird.

If any one of those pieces is missing, the MCP server can still start, but the
`status` tool will report that the Thunderbird bridge is not connected.

For a Windows agent installing this for a non-coding user, use
[AGENT_WINDOWS_INSTALL.md](AGENT_WINDOWS_INSTALL.md) and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

## Build

Use Node 22.5 or newer (the durable reply ledger uses the built-in SQLite API).

```sh
npm install
npm run build
npm test
```

## Register the Thunderbird Native Host

```sh
npm run install-native
```

This writes the native messaging manifest and wrapper for the current user:

- macOS Thunderbird per-user path: `~/Library/Mozilla/NativeMessagingHosts/com.thunderbird_mcp.bridge.json`
- Windows per-user registry:
  - `HKCU\Software\Mozilla\NativeMessagingHosts\com.thunderbird_mcp.bridge`
  - `HKCU\Software\Wow6432Node\Mozilla\NativeMessagingHosts\com.thunderbird_mcp.bridge`
- Linux per-user path: `~/.mozilla/native-messaging-hosts/com.thunderbird_mcp.bridge.json`

The Windows installer intentionally writes both registry views because some
Thunderbird builds look in the non-Wow6432Node key and some Windows app
packagings have been observed to check the Wow6432Node view.

## Install the Thunderbird Add-on

Build the XPI:

```sh
npm run package:xpi
```

Install `build/thunderbird-mcp-bridge-0.2.0.xpi` through Thunderbird:

1. Open Thunderbird.
2. Open Add-ons Manager.
3. Use the gear menu.
4. Choose **Install Add-on From File...**.
5. Select the XPI from `build/`.
6. Accept the permission prompt.
7. Fully quit and restart Thunderbird.

The add-on uses a persistent Manifest V2 background page on purpose. The native
messaging connection must stay open so the local broker can serve MCP requests.

For development, use Thunderbird Add-ons Manager > gear menu > Debug Add-ons >
Load Temporary Add-on and select:

```text
addon/manifest.json
```

## Connect Claude Code

After `npm run build`, either run the printed helper:

```sh
npm run claude-config
```

or add the server directly:

```sh
claude mcp add --scope user thunderbird-mcp -- node <repo>/dist/host/src/cli.js mcp
```

On Windows, use the full path to `node.exe` if `node` is not on the same PATH
used by Claude Code.

## Connect Claude Desktop

For Claude Desktop JSON config, use the classic `command`/`args` shape. Do not
include the Claude Code-only `type` field unless your Desktop build explicitly
requires it.

```json
{
  "mcpServers": {
    "thunderbird": {
      "command": "node",
      "args": ["<repo>/dist/host/src/cli.js", "mcp"],
      "env": {}
    }
  }
}
```

When editing the config file by script, preserve existing keys and write UTF-8
without BOM. A BOM at the start of `claude_desktop_config.json` can make
Claude Desktop fail with "Could not load app settings".

## Connect Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.thunderbird]
command = "node"
args = ["<repo>/dist/host/src/cli.js", "mcp"]
```

On Windows, single-quoted TOML strings are convenient for absolute paths because
backslashes do not need escaping:

```toml
[mcp_servers.thunderbird]
command = '<absolute path to node.exe>'
args = ['<absolute path to repo>\dist\host\src\cli.js', 'mcp']
```

## Package Claude Desktop MCPB

```sh
npm run build
npm run package:mcpb
```

Install the generated `.mcpb` through Claude Desktop Settings > Extensions >
Advanced settings > Install Extension.

The MCPB only installs the Claude-side MCP server. Users still need the
Thunderbird add-on and native host registration.

## Smoke Test

Start or restart Thunderbird after installing the add-on, then run:

```sh
node --input-type=module -e "import('./dist/host/src/mcp-tools.js').then(async ({callTool}) => console.log(JSON.stringify(await callTool('status', {}), null, 2)))"
```

Expected:

```json
{
  "connected": true,
  "broker": {
    "connected": true
  }
}
```

Then run one read-only Thunderbird API smoke test:

```sh
node --input-type=module -e "import('./dist/host/src/mcp-tools.js').then(async ({callTool}) => callTool('list_folders', { includeSubFolders: false })).then((result) => console.log(JSON.stringify({ accountCount: result.accounts?.length ?? 0 }, null, 2)))"
```

Use smoke tests sequentially. Parallel broker smoke calls can make transient
connection failures harder to interpret.

## Useful Smoke Prompts

```text
Use Thunderbird MCP to check status, then summarize the currently displayed Thunderbird message. Do not send email.
```

```text
Use Thunderbird MCP to search for PDF attachments from last year with invoice in the filename. Show sender, subject, date, filename, size, message id, and part name.
```

```text
Use Thunderbird MCP to save the matching attachment to my Downloads folder. Do not overwrite existing files.
```
