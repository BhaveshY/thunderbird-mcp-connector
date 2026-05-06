# Troubleshooting

These notes come from real install failures agents hit on Windows and are meant
to make the next install less mysterious.

For a normal Windows user install, start with `scripts/install-windows.ps1`.
Use the sections below only when that one-shot script cannot complete.

## Claude Desktop: "Could not load app settings"

Likely causes:

- `claude_desktop_config.json` was written with a UTF-8 BOM.
- The JSON is valid for Claude Code but not for Claude Desktop.

Fix:

- Validate the JSON with a parser.
- Rewrite it as UTF-8 without BOM.
- For Claude Desktop, prefer:

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

Claude Code may store `type: "stdio"` in its own config; do not assume every
Claude Desktop build accepts that field in `claude_desktop_config.json`.

## `npm run package:xpi` fails on Windows

Old versions of the script called a system `zip` executable. Windows often does
not have one. Do not replace it with PowerShell `Compress-Archive` unless you
verify the archive entries use forward slashes.

The XPI must contain entries like:

```text
manifest.json
src/background.js
icons/icon.svg
```

Backslash entries such as `src\background.js` can leave the add-on visible and
active while the background script fails to load.

## Add-on active, but no `native-host` process

Check these items:

- Thunderbird was fully restarted after the XPI was installed.
- The add-on is enabled in Add-ons Manager.
- `npm run install-native` was run after `npm run build`.
- The native messaging manifest allows `thunderbird-mcp@local`.
- The installed XPI has forward-slash paths.

On Windows, confirm the registry entry exists under at least:

```text
HKCU\Software\Mozilla\NativeMessagingHosts\com.thunderbird_mcp.bridge
```

The installer also writes:

```text
HKCU\Software\Wow6432Node\Mozilla\NativeMessagingHosts\com.thunderbird_mcp.bridge
```

## XPI cannot be replaced

Thunderbird memory-maps installed XPI files while running. If copying the XPI
fails with a file-in-use error, fully quit Thunderbird first:

- Use File > Exit from Thunderbird.
- Wait until no `thunderbird` processes remain.
- Replace the XPI.
- Start Thunderbird again.

Avoid force-killing Thunderbird unless the user explicitly approves it.

## MCP starts, but `status.connected` is false

Interpret the error text:

- "Thunderbird bridge is not connected" means no broker state file exists yet.
  Open or restart Thunderbird and ensure the add-on is enabled.
- "Could not connect to Thunderbird bridge" usually means a stale broker state
  file or a native host that exited after writing state.

The broker state file is:

```text
~/.thunderbird-mcp/broker.json
```

If Thunderbird is closed and this file remains, remove it and restart
Thunderbird.

## Verify the full path

Run these in order:

```sh
npm run build
npm run install-native
npm run package:xpi
```

Install the XPI, restart Thunderbird, then run:

```sh
node --input-type=module -e "import('./dist/host/src/mcp-tools.js').then(async ({callTool}) => console.log(JSON.stringify(await callTool('status', {}), null, 2)))"
```

A good result includes:

```json
{
  "connected": true,
  "broker": {
    "connected": true
  }
}
```

Then verify a read-only Thunderbird API call:

```sh
node --input-type=module -e "import('./dist/host/src/mcp-tools.js').then(async ({callTool}) => callTool('list_folders', { includeSubFolders: false })).then((result) => console.log(JSON.stringify({ accountCount: result.accounts?.length ?? 0 }, null, 2)))"
```

Do not use message-reading tools in automated smoke tests unless the user
explicitly asks for mail content to be inspected.
