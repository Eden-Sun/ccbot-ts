# ccbot-ts

TypeScript port of [six-ddc/ccbot](https://github.com/six-ddc/ccbot) — Control Claude Code sessions remotely via Telegram: monitor, interact, and manage AI coding sessions running in tmux.

## Why rewrite in TypeScript?

The original [ccbot](https://github.com/six-ddc/ccbot) is written in Python. This port rewrites it in TypeScript using [Bun](https://bun.sh) and [grammY](https://grammy.dev) for the following reasons:

- **Single runtime** — Bun runs TypeScript natively, no compilation step or virtual environment needed
- **Type safety** — catch bugs at development time instead of runtime
- **Modern Telegram framework** — [grammY](https://grammy.dev) is well-typed and actively maintained
- **Easier to extend** — handlers are split into focused modules under `src/handlers/`

All features and behaviour are kept as close to the original as possible.

## Why CCBot?

Claude Code runs in your terminal. When you step away from your computer — commuting, on the couch, or just away from your desk — the session keeps working, but you lose visibility and control.

CCBot solves this by letting you **seamlessly continue the same session from Telegram**. The key insight is that it operates on **tmux**, not the Claude Code SDK. Your Claude Code process stays exactly where it is, in a tmux window on your machine. CCBot simply reads its output and sends keystrokes to it. This means:

- **Switch from desktop to phone mid-conversation** — Claude is working on a refactor? Walk away, keep monitoring and responding from Telegram.
- **Switch back to desktop anytime** — Since the tmux session was never interrupted, just `tmux attach` and you're back in the terminal with full scrollback and context.
- **Run multiple sessions in parallel** — Each Telegram topic maps to a separate tmux window, so you can juggle multiple projects from one chat group.

## Features

- **Topic-based sessions** — Each Telegram topic maps 1:1 to a tmux window and Claude session
- **Real-time notifications** — Get Telegram messages for assistant responses, thinking content, tool use/result, and local command output
- **Interactive UI** — Navigate AskUserQuestion, ExitPlanMode, and Permission Prompts via inline keyboard
- **Send messages** — Forward text to Claude Code via tmux keystrokes
- **Slash command forwarding** — Send any `/command` directly to Claude Code (e.g. `/clear`, `/compact`, `/cost`)
- **Create new sessions** — Start Claude Code sessions from Telegram via directory browser
- **Kill sessions** — Close a topic to auto-kill the associated tmux window
- **Message history** — Browse conversation history with pagination (newest first)
- **Hook-based session tracking** — Auto-associates tmux windows with Claude sessions via `SessionStart` hook
- **Persistent state** — Thread bindings and read offsets survive restarts

## Prerequisites

- **[Bun](https://bun.sh)** v1.0+ — `curl -fsSL https://bun.sh/install | bash`
- **tmux** — must be installed and available in PATH
- **Claude Code** — the CLI tool (`claude`) must be installed

## Installation

```bash
git clone https://github.com/Eden-Sun/ccbot-ts.git
cd ccbot-ts
bun install
```

## Configuration

**1. Create a Telegram bot and enable Threaded Mode:**

1. Chat with [@BotFather](https://t.me/BotFather) to create a new bot and get your bot token
2. Open @BotFather's profile page, tap **Open App** to launch the mini app
3. Select your bot, then go to **Settings** > **Bot Settings**
4. Enable **Threaded Mode**

**2. Configure environment variables:**

Create `~/.ccbot/.env`:

```ini
TELEGRAM_BOT_TOKEN=your_bot_token_here
ALLOWED_USERS=your_telegram_user_id
```

**Required:**

| Variable             | Description                       |
| -------------------- | --------------------------------- |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather         |
| `ALLOWED_USERS`      | Comma-separated Telegram user IDs |

**Optional:**

| Variable                  | Default    | Description                                        |
| ------------------------- | ---------- | -------------------------------------------------- |
| `TMUX_SESSION_NAME`       | `ccbot`    | Tmux session name                                  |
| `CLAUDE_COMMAND`          | `claude`   | Command to run in new windows                      |
| `MONITOR_POLL_INTERVAL`   | `2.0`      | Polling interval in seconds                        |
| `CCBOT_SHOW_HIDDEN_DIRS`  | `false`    | Show hidden (dot) directories in directory browser |
| `CCBOT_CLAUDE_PROJECTS_PATH` | `~/.claude/projects` | Claude Code projects path             |

> If running on a VPS where there's no interactive terminal to approve permissions, consider:
>
> ```ini
> CLAUDE_COMMAND=IS_SANDBOX=1 claude --dangerously-skip-permissions
> ```

## Hook Setup (Recommended)

Manually add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [{ "type": "command", "command": "node /path/to/ccbot-ts/hook.js", "timeout": 5 }]
      }
    ]
  }
}
```

This writes window-session mappings to `~/.ccbot/session_map.json`, so the bot automatically tracks which Claude session is running in each tmux window — even after `/clear` or session restarts.

## Usage

```bash
bun run src/index.ts
```

Development (hot reload):

```bash
bun --hot src/index.ts
```

### Commands

**Bot commands:**

| Command       | Description                     |
| ------------- | ------------------------------- |
| `/start`      | Show welcome message            |
| `/history`    | Message history for this topic  |
| `/screenshot` | Capture terminal screenshot     |
| `/esc`        | Send Escape to interrupt Claude |

**Claude Code commands (forwarded via tmux):**

| Command    | Description                  |
| ---------- | ---------------------------- |
| `/clear`   | Clear conversation history   |
| `/compact` | Compact conversation context |
| `/cost`    | Show token/cost usage        |
| `/help`    | Show Claude Code help        |
| `/memory`  | Edit CLAUDE.md               |

Any unrecognized `/command` is also forwarded to Claude Code as-is (e.g. `/review`, `/doctor`, `/init`).

### Topic Workflow

**1 Topic = 1 Window = 1 Session.** The bot runs in Telegram Forum (topics) mode.

**Creating a new session:**

1. Create a new topic in the Telegram group
2. Send any message in the topic
3. A directory browser appears — select the project directory
4. A tmux window is created, `claude` starts, and your pending message is forwarded

**Sending messages:**

Once a topic is bound to a session, just send text in that topic — it gets forwarded to Claude Code via tmux keystrokes.

**Killing a session:**

Close (or delete) the topic in Telegram. The associated tmux window is automatically killed and the binding is removed.

### Message History

Navigate with inline buttons:

```
📋 [project-name] Messages (42 total)

───── 14:32 ─────

👤 fix the login bug

───── 14:33 ─────

I'll look into the login bug...

[◀ Older]    [2/9]    [Newer ▶]
```

### Notifications

The monitor polls session JSONL files every 2 seconds and sends notifications for:

- **Assistant responses** — Claude's text replies
- **Thinking content** — Shown as expandable blockquotes
- **Tool use/result** — Summarized with stats (e.g. "Read 42 lines", "Found 5 matches")
- **Local command output** — stdout from commands like `git status`, prefixed with `❯ command_name`

Notifications are delivered to the topic bound to the session's window.

## Running Claude Code in tmux

### Option 1: Create via Telegram (Recommended)

1. Create a new topic in the Telegram group
2. Send any message
3. Select the project directory from the browser

### Option 2: Create Manually

```bash
tmux attach -t ccbot
tmux new-window -n myproject -c ~/Code/myproject
# Then start Claude Code in the new window
claude
```

The window must be in the `ccbot` tmux session (configurable via `TMUX_SESSION_NAME`).

## Data Storage

| Path                              | Description                                                              |
| --------------------------------- | ------------------------------------------------------------------------ |
| `~/.ccbot/state.json`             | Thread bindings, window states, display names, and per-user read offsets |
| `~/.ccbot/session_map.json`       | Hook-generated `{tmux_session:window_id: {session_id, cwd, window_name}}` mappings |
| `~/.ccbot/monitor_state.json`     | Monitor byte offsets per session (prevents duplicate notifications)      |
| `~/.claude/projects/`            | Claude Code session data (read-only)                                     |

## Project Structure

```
src/
├── index.ts          # Entry point — wires everything together
├── bot.ts            # Telegram bot handlers (main UI layer)
├── config.ts         # Configuration from environment variables
├── session.ts        # Session map management and state persistence
├── tmux.ts           # tmux window management (list, create, send keys, kill)
├── monitor.ts        # Output monitor (polls JSONL → sends to Telegram)
├── monitorState.ts   # Monitor state persistence (byte offsets)
├── transcript.ts     # Claude Code JSONL transcript parser
├── terminal.ts       # Terminal pane parsing (interactive UI + status line)
├── markdown.ts       # Markdown → Telegram MarkdownV2 conversion
├── screenshot.ts     # Terminal text → image
├── utils.ts          # Shared utilities
├── types.ts          # Shared TypeScript types
└── handlers/
    ├── callbackData.ts     # Callback data constants (CB_* prefixes)
    ├── cleanup.ts          # Session cleanup handlers
    ├── directoryBrowser.ts # Directory browser inline keyboard UI
    ├── history.ts          # Message history pagination
    ├── interactiveUI.ts    # Interactive UI (AskUser, ExitPlan, Permissions)
    ├── messageQueue.ts     # Per-user message queue + worker (merge, rate limit)
    ├── messageSender.ts    # safe_reply / safe_edit / safe_send helpers
    ├── responseBuilder.ts  # Response message building (tool_use, thinking, etc.)
    └── statusPolling.ts    # Terminal status line polling
```

## Credits

- Original Python bot: [six-ddc/ccbot](https://github.com/six-ddc/ccbot)
- Telegram framework: [grammY](https://grammy.dev)
- Runtime: [Bun](https://bun.sh)

## License

MIT
