# iMessage Codex Bridge

iMessage-first bridge for Codex via Sendblue.

## What this does

- Polls Sendblue for inbound iMessages from one trusted number.
- Routes user text to Codex app-server (`turn/start` / `turn/steer`).
- Forwards inbound media as attachment URLs into Codex context.
- Sends typing indicators and best-effort read receipts through Sendblue (configurable).
- Applies optional outbound Markdown-to-Unicode styling for iMessage readability.
- Accepts authenticated webhook notifications and routes them through Codex notification turns.
- Supports interrupt/reset/debug/control commands.
- Keeps structured local audit logs in SQLite.

## Architecture

- Runtime: local Mac terminal process
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
- `/notifications [count] [source]`

## Setup

1. Install prerequisites:

- Node.js `>=24`
- Sendblue account with one sending number and one trusted inbound number
- Codex CLI/app-server with `turn/start` + `turn/steer` support

2. Install/prepare Codex app-server:

Current workaround (until `0.99+` is officially released): build from latest `main` and point `CODEX_BIN` to the built binary.

```bash
git clone https://github.com/openai/codex.git
cd codex/codex-rs
CARGO_PROFILE_RELEASE_LTO=thin cargo build --release -p codex-cli --bin codex
```

Binary path will be:

```bash
<repo>/codex-rs/target/release/codex
```

When `0.99+` is released, you can use the normal installed `codex` binary and set:

```bash
CODEX_BIN=codex
```

3. Install bridge dependencies:

```bash
npm install
```

4. Create `.env` from `.env.example` and fill values.

Important for current pre-`0.99` setup:

```bash
CODEX_BIN=/absolute/path/to/codex-rs/target/release/codex
```

Backlog behavior (recommended default):

```bash
DISCARD_BACKLOG_ON_START=1
```

On a brand-new local state DB, this marks current inbound history as seen at startup so only new incoming messages are processed.

Notification webhook setup:

```bash
ENABLE_NOTIFICATION_WEBHOOK=1
NOTIFICATION_WEBHOOK_SECRET=<long-random-secret>
NOTIFICATION_WEBHOOK_PORT=8787
NOTIFICATION_WEBHOOK_PATH=/notifications/webhook
```

Send webhook requests to:

```bash
POST http://<bridge-host>:8787/notifications/webhook
Authorization: Bearer <NOTIFICATION_WEBHOOK_SECRET>
Content-Type: application/json
```

Optional: to keep up with upstream Codex changes before `0.99`, refresh/rebuild periodically:

```bash
cd /path/to/codex
git fetch origin
git checkout main
git pull --ff-only
cd codex-rs
CARGO_PROFILE_RELEASE_LTO=thin cargo build --release -p codex-cli --bin codex
```

5. Start manually for development:

```bash
./scripts/run-dev.sh
```

6. Keep it running in a terminal:

```bash
while true; do ./scripts/run-dev.sh; echo "bridge exited, restarting in 2s"; sleep 2; done
```

7. Optional detached mode via tmux:

```bash
tmux new -s imessage-bridge 'cd /absolute/path/to/imessage-codex-bridge && ./scripts/run-dev.sh'
```

8. In iMessage, text from trusted number to the Sendblue number.

## Run notes

- Run exactly one bridge process at a time.
- If you run it in tmux:

```bash
tmux attach -t imessage-bridge
```

- Stop tmux-run bridge:

```bash
tmux kill-session -t imessage-bridge
```

## Development checks

```bash
npm run lint
npm test
npm run build
```

## Notes

- v1 is text outbound; inbound media is forwarded to Codex as URL context.
- v1 is single-trusted-user only.
- Notification decisions use per-turn `outputSchema` (`send` vs `suppress`) and are audited in SQLite.
- Assistant/tool internals are not pushed by default; use `/debug` for timeline.
- Requires a Codex app-server build that supports `turn/steer` (latest `origin/main` or `0.99+` once released).
- Read receipts are best-effort: the Sendblue `mark-read` call can return success while iMessage UI still shows `Delivered`.
- Outbound formatting defaults to `ENABLE_OUTBOUND_UNICODE_FORMATTING=1` and converts markdown markers like `**bold**`, `*italic*`, and `` `code` ``.
- Fresh-install safety defaults to `DISCARD_BACKLOG_ON_START=1` so historic inbound messages are not replayed into Codex on first run.
- Notification retention defaults: 90 days plus 25,000-row cap.

## TODO

- Add a single-instance process lock (PID/lockfile) so only one bridge process can run at a time.
- Add `/health` or `/diag` command with runtime diagnostics (thread, active turn, model, feature flags, recent inbound/outbound timestamps).
