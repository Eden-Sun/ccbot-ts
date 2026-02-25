# ccbot-ts

> TypeScript port of [six-ddc/ccbot](https://github.com/six-ddc/ccbot) — a Telegram ↔ tmux bridge for Claude Code.

## What is this?

[six-ddc/ccbot](https://github.com/six-ddc/ccbot) is a Python bot that lets you control Claude Code sessions via Telegram. Each Telegram topic maps 1:1 to a tmux window, giving you a clean multi-session interface from your phone.

**ccbot-ts** rewrites the same bot in TypeScript using [Bun](https://bun.sh) and [grammY](https://grammy.dev).

### Why rewrite it?

- **Single runtime** — Bun runs TypeScript natively, no compilation step needed
- **Type safety** — catch bugs at development time instead of runtime
- **grammY** — modern, well-typed Telegram bot framework vs python-telegram-bot
- **Easier to extend** — handlers are split into focused modules under `src/handlers/`

## Features

All features from the original ccbot, plus:

- Telegram forum topics → tmux windows (1:1 mapping)
- Send messages to Claude Code sessions
- Monitor session output and stream it back to Telegram
- Screenshot support (pane → image)
- Directory browser for navigating project paths
- Interactive UI for key input (arrows, tab, esc, etc.)
- Command history
- Session transcript parsing

## Requirements

- [Bun](https://bun.sh) v1.0+
- tmux
- Claude Code CLI (`claude`)
- A Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- A Telegram group with **Topics** enabled

## Setup

1. **Clone the repo**
   ```bash
   git clone https://github.com/edensun/ccbot-ts.git
   cd ccbot-ts
   bun install
   ```

2. **Configure environment**

   Create a `.env` file (or place it at `~/.ccbot/.env`):
   ```env
   TELEGRAM_BOT_TOKEN=your_bot_token_here
   ALLOWED_USERS=123456789,987654321
   TMUX_SESSION_NAME=ccbot
   CLAUDE_COMMAND=claude
   ```

   | Variable | Required | Default | Description |
   |----------|----------|---------|-------------|
   | `TELEGRAM_BOT_TOKEN` | ✅ | — | Bot token from BotFather |
   | `ALLOWED_USERS` | ✅ | — | Comma-separated Telegram user IDs |
   | `TMUX_SESSION_NAME` | | `ccbot` | tmux session name |
   | `CLAUDE_COMMAND` | | `claude` | Path to Claude Code binary |
   | `MONITOR_POLL_INTERVAL` | | `2.0` | Output poll interval (seconds) |
   | `CCBOT_SHOW_HIDDEN_DIRS` | | `false` | Show hidden dirs in browser |
   | `CCBOT_CLAUDE_PROJECTS_PATH` | | `~/.claude/projects` | Claude projects path |

3. **Run**
   ```bash
   bun run src/index.ts
   ```

   Development (hot reload):
   ```bash
   bun --hot src/index.ts
   ```

## Project Structure

```
src/
├── index.ts          # Entry point — wires everything together
├── bot.ts            # Telegram bot handlers (main UI layer)
├── config.ts         # Environment config (singleton)
├── session.ts        # Session map management
├── tmux.ts           # tmux interaction layer
├── monitor.ts        # Output monitor (polls tmux → sends to Telegram)
├── monitorState.ts   # Monitor state persistence
├── transcript.ts     # Claude Code transcript parser
├── terminal.ts       # Terminal output parsing utilities
├── markdown.ts       # Markdown ↔ Telegram formatting conversion
├── screenshot.ts     # Pane screenshot (text → image)
├── utils.ts          # Shared utilities
├── types.ts          # Shared TypeScript types
└── handlers/
    ├── callbackData.ts     # Callback data constants
    ├── cleanup.ts          # Session cleanup handlers
    ├── directoryBrowser.ts # File/dir browser UI
    ├── history.ts          # Command history
    ├── interactiveUI.ts    # Interactive key input UI
    ├── messageQueue.ts     # Message send queue
    ├── messageSender.ts    # Telegram message sending abstraction
    ├── responseBuilder.ts  # Response formatting
    └── statusPolling.ts    # Session status polling
```

## Credits

- Original Python bot: [six-ddc/ccbot](https://github.com/six-ddc/ccbot)
- Telegram framework: [grammY](https://grammy.dev)
- Runtime: [Bun](https://bun.sh)

## License

MIT
