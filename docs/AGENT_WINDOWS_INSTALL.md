# Agent Windows Install

This is the handoff for a Claude Code or Codex agent installing the connector
on a non-coding Windows user's PC.

The user should be able to paste the GitHub link and ask the agent to install
it. Do not ask the user to edit JSON, TOML, registry keys, or Thunderbird
profile files by hand.

## One-shot Flow

1. Clone or open the repository.
2. Run the Windows installer from the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

The script handles:

- Node.js 20+ detection and winget install when missing.
- Thunderbird detection and winget install when missing.
- `npm install`, build, tests, XPI packaging, and native host registration.
- Thunderbird add-on staging in the active/default Thunderbird profile.
- Claude Code MCP registration when a Claude Code CLI is discoverable.
- Claude Desktop JSON config updates, written as UTF-8 without BOM.
- Codex config update when `~/.codex/config.toml` exists.
- A status smoke test and a read-only `list_folders` smoke test.

If the user has unsaved Thunderbird compose windows, Thunderbird may refuse to
close. In that case, ask the user to save/close those windows, quit Thunderbird
with File > Exit, and rerun the same script.

## If Dependencies Are Missing

The script uses `winget` for missing user dependencies:

- `OpenJS.NodeJS.LTS`
- `Mozilla.Thunderbird`

If `winget` is not available, install those manually, then rerun the script.

No Python dependency is required.

## Final User Message

After a successful install, keep the final explanation short:

```text
Installed Thunderbird MCP.

Next steps:
1. Keep Thunderbird open and signed in.
2. If Thunderbird asks to approve the Thunderbird MCP Bridge add-on, approve it.
3. In Claude, ask: "Use Thunderbird MCP to check status."

It reads mail only when you ask. It can create drafts, but it cannot send email.
```

Do not paste message bodies, addresses, or private mail content into the final
install summary.
