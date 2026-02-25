/**
 * CCBot TypeScript — entry point.
 *
 * Starts:
 *   1. Hook HTTP server (for Claude Code SessionStart events)
 *   2. Tmux session initialization
 *   3. Session map load (syncs existing tmux windows → sessions)
 *   4. Grammy Telegram bot (polling)
 *
 * Usage:
 *   bun run src/index.ts
 *   bun --hot src/index.ts   # development with hot reload
 */

import { createBot, postInit, postShutdown } from "./bot"
import { startHookServer } from "./hook"
import { tmuxManager } from "./tmux"
import { sessionManager } from "./session"
import { config } from "./config"

async function main(): Promise<void> {
  console.log("CCBot starting…")

  // 1. Start hook HTTP server
  const hookServer = startHookServer()
  console.log(`Hook server: http://localhost:${hookServer.port}`)

  // 2. Ensure tmux session exists
  const session = tmuxManager.getOrCreateSession()
  console.log(`Tmux session: ${session}`)

  // 3. Load session map (sync window → session bindings)
  await sessionManager.loadSessionMap()
  console.log("Session map loaded")

  // 4. Create and initialize bot
  const bot = createBot()

  // Post-init: set commands, resolve stale IDs, start monitor + polling
  await postInit(bot)

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down…`)
    await postShutdown()
    await bot.stop()
    hookServer.stop()
    console.log("CCBot stopped.")
    process.exit(0)
  }

  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))

  // Start polling (blocks until stopped)
  console.log("Bot starting… (Ctrl-C to stop)")
  await bot.start({
    onStart: botInfo => {
      console.log(`Bot @${botInfo.username} is running`)
    },
  })
}

main().catch(err => {
  console.error("Fatal error:", err)
  process.exit(1)
})
