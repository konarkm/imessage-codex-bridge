# iMessage Codex Bridge

Standalone iMessage-first bridge for Codex app-server using Sendblue.

## What this does

- Polls Sendblue for inbound iMessages from one trusted number.
- Routes user text to Codex app-server (`turn/start` / `turn/steer`).
- Streams assistant message deltas back to iMessage.
- Supports interrupt/reset/debug/control commands.
- Keeps structured local audit logs in SQLite.

## Architecture

- Runtime: local Mac daemon
- Transport to Codex: local stdio JSON-RPC (`codex app-server --listen stdio://`)
- Transport to iMessage: Sendblue API polling + send message API
- Safety mode default: danger-full-access (per v1 decision)

## Commands

- `/help`
- `/status`
- `/stop`
- `/reset`
- `/debug`
- `/thread`
- `/thread new`
- `/compact`
- `/model <id>`
- `/pause` (kill switch)
- `/resume`

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from `.env.example` and fill values.

3. Start manually for development:

```bash
./scripts/run-dev.sh
```

4. In iMessage, text from trusted number to the Sendblue number.

## launchd (persistent)

Install/refresh launch agent:

```bash
./scripts/install-launchd.sh
```

Useful commands:

```bash
launchctl unload ~/Library/LaunchAgents/com.imessage.codex.bridge.plist
launchctl load ~/Library/LaunchAgents/com.imessage.codex.bridge.plist
```

Logs:

- `/tmp/imessage-codex-bridge.out.log`
- `/tmp/imessage-codex-bridge.err.log`

## Development checks

```bash
npm run lint
npm test
npm run build
```

## Notes

- v1 is text-only inbound/outbound.
- v1 is single-trusted-user only.
- Assistant/tool internals are not pushed by default; use `/debug` for timeline.
