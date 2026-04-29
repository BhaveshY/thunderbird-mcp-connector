# Install and Test

## Build

```sh
npm install
npm run build
```

## Register the Thunderbird Native Host

```sh
npm run install-native
```

This writes the Mozilla native-messaging manifest for the current user:

- macOS Thunderbird per-user path: `~/Library/Mozilla/NativeMessagingHosts/com.thunderbird_mcp.bridge.json`
- Windows per-user registry: `HKCU\Software\Mozilla\NativeMessagingHosts\com.thunderbird_mcp.bridge`
- Linux per-user path: `~/.mozilla/native-messaging-hosts/com.thunderbird_mcp.bridge.json`

## Install the Thunderbird Add-on

For development, open Thunderbird Add-ons Manager, choose the gear menu, select Debug Add-ons, then Load Temporary Add-on and select:

```text
addon/manifest.json
```

For an XPI:

```sh
npm run package:xpi
```

Then install `build/thunderbird-mcp-bridge-0.1.0.xpi` from Thunderbird's Add-ons Manager gear menu.

## Connect Claude Code

After `npm run build`, print a Claude Code config:

```sh
npm run claude-config
```

Or run the printed `claude mcp add-json ...` command.

## Package Claude Desktop MCPB

```sh
npm run build
npm run package:mcpb
```

Install the generated `.mcpb` through Claude Desktop Settings > Extensions > Advanced settings > Install Extension.

The MCPB only installs the Claude-side MCP server. Users still need the Thunderbird add-on and native host registration.

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
