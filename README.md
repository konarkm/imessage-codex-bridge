# iMessage Codex Bridge

iMessage-first bridge for Codex via Sendblue.

## Demo

Quick preview (tap/click to open full video):

[![iMessage Codex Bridge demo](docs/media/imessage-demo.gif)](https://youtube.com/shorts/Pp9IAUcCs3s)

Full demo video: https://youtube.com/shorts/Pp9IAUcCs3s

## What this does

- Polls Sendblue for inbound iMessages from one trusted number.
- Routes user text to Codex app-server (`turn/start` / `turn/steer`).
- Forwards inbound media as attachment URLs into Codex context.
- Sends typing indicators and best-effort read receipts through Sendblue (configurable).
- Applies optional outbound Markdown-to-Unicode styling for iMessage readability.
- Accepts authenticated webhook notifications and routes them through Codex notification turns.
- Supports interrupt/reset/debug/control commands.
- Keeps structured local audit logs in SQLite.

## Why this is useful

- iMessage-native control surface for Codex without changing your daily messaging workflow.
- Local-first runtime (Mac terminal process + local Codex app-server).
- Auditable message/notification history with explicit operational controls.

## Architecture

- Runtime: local Mac terminal process
- Codex execution: bridge starts and manages a local Codex app-server process.
- Transport to Codex: local stdio JSON-RPC to app-server (`codex app-server --listen stdio://`)
- Transport to iMessage: Sendblue API polling + send message API
- Safety mode default: danger-full-access. Use with caution.

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
- `/effort [level]`
- `/spark`
- `/pause` (kill switch)
- `/resume`
- `/notifications [count] [source]`
- `/restart <codex|bridge|both>`

## Setup

1. Install prerequisites:

- Node.js `>=24`
- Sendblue account with one sending number and one trusted inbound number
- Codex CLI `>=0.101.0`

2. Verify Codex CLI:

```bash
codex --version
```

Expected: `0.101.0` or newer.

3. Install bridge dependencies:

```bash
npm install
```

4. Create `.env` from `.env.example` and fill values.

Recommended Codex settings:

```bash
CODEX_BIN=codex
CODEX_CWD=/absolute/path/to/your/workspace
CODEX_MODEL=gpt-5.3-codex
```

Backlog behavior (recommended default):

```bash
DISCARD_BACKLOG_ON_START=1
```

When enabled, each startup marks currently visible inbound history as seen so only messages that arrive after startup are processed.

Optional: Notification webhook setup (for webhook-driven notifications):

```bash
ENABLE_NOTIFICATION_WEBHOOK=1
NOTIFICATION_WEBHOOK_SECRET=<long-random-secret>
NOTIFICATION_WEBHOOK_PORT=8787
NOTIFICATION_WEBHOOK_PATH=/events
```

Send webhook requests to:

```bash
POST http://<bridge-host>:8787/events
Authorization: Bearer <NOTIFICATION_WEBHOOK_SECRET>
Content-Type: application/json
```

Auth behavior:

- `Authorization: Bearer <NOTIFICATION_WEBHOOK_SECRET>` or `X-Bridge-Secret`.

If you do not need webhook ingress, set:

```bash
ENABLE_NOTIFICATION_WEBHOOK=0
```

5. Start the bridge:

```bash
./scripts/run.sh
```

6. Keep it running in a terminal:

`./scripts/run.sh` supervises intentional restarts:

- if bridge exits with code `42` (from `/restart bridge` or `/restart both`), it relaunches automatically.
- for other non-zero exits, it stops so crash loops remain visible.
- it enforces a single-instance lock (`.bridge-run.lock`) to prevent duplicate bridge processes.

7. Optional detached mode via tmux:

```bash
tmux new -s imessage-bridge 'cd /absolute/path/to/imessage-codex-bridge && ./scripts/run.sh'
```

8. In iMessage, text from trusted number to the Sendblue number.

## Run notes

- Run exactly one bridge process at a time.
- If the script reports a stale lock after an unclean exit, delete `.bridge-run.lock` and start again.
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
- Supported Codex models include `gpt-5.3-codex` and `gpt-5.3-codex-spark`.
- Reasoning effort is model-specific and persisted per model (`none|minimal|low|medium|high|xhigh`).
- Default reasoning effort is `medium` for non-spark models and `xhigh` for spark models.
- `/effort` shows/sets effort for the current model.
- `/model` can optionally set effort inline (for example `/model gpt-5.3-codex-spark-low` or `/model gpt-5.3-codex-spark low`).
- `/spark` toggles between the current model and spark, preserving the prior model+effort pair.
- If `gpt-5.3-codex-spark` is selected but unavailable for the current account, the bridge automatically falls back to `gpt-5.3-codex` and sends a user-visible notice.
- Notification decisions use per-turn `outputSchema` (`send` vs `suppress`) and are audited in SQLite.
- Restart controls:
  - `/restart codex` sends an immediate "restarting" ack, restarts only the Codex app-server child, then sends a "back online" confirmation.
  - `/restart bridge` sends an immediate "restarting" ack, triggers a full bridge restart, then sends a "back online" confirmation after process relaunch.
  - `/restart both` does the same as bridge restart and confirms both are back online after relaunch.
- Assistant/tool internals are not pushed by default; use `/debug` for timeline.
- Requires Codex CLI `>=0.101.0`.
- Read receipts are best-effort: the Sendblue `mark-read` call can return success while iMessage UI still shows `Delivered`.
- Outbound formatting defaults to `ENABLE_OUTBOUND_UNICODE_FORMATTING=1` and converts markdown markers like `**bold**`, `*italic*`, and `` `code` ``.
- Startup safety defaults to `DISCARD_BACKLOG_ON_START=1` so inbound messages that predate startup are not replayed into Codex.
- Notification retention defaults: 90 days plus 25,000-row cap.

## TODO

- Add `/health` or `/diag` command with runtime diagnostics (thread, active turn, model, feature flags, recent inbound/outbound timestamps).
