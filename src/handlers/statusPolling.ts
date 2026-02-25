/**
 * Terminal status line polling for thread-bound windows.
 *
 * Port of status_polling.py. Provides background polling of terminal
 * status lines for all active users:
 *   - Detects Claude Code status (working, waiting, etc.)
 *   - Detects interactive UIs (permission prompts) not triggered via JSONL
 *   - Updates status messages in Telegram
 *   - Polls thread_bindings (each topic = one window)
 *   - Periodically probes topic existence via unpinAllForumTopicMessages
 */

import type { Bot } from "grammy"
import { GrammyError } from "grammy"
import { sessionManager } from "../session"
import { isInteractiveUI, parseStatusLine } from "../terminal"
import { tmuxManager } from "../tmux"
import {
  clearInteractiveMsg,
  getInteractiveWindow,
  handleInteractiveUI,
} from "./interactiveUI"
import { clearTopicState } from "./cleanup"
import { enqueueStatusUpdate, getMessageQueue } from "./messageQueue"

const STATUS_POLL_INTERVAL = 1000 // ms
const TOPIC_CHECK_INTERVAL = 60_000 // ms

const _paneHashes: Map<string, string> = new Map()

function simpleHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h, 33) ^ s.charCodeAt(i)
  }
  return (h >>> 0).toString(16)
}

export async function updateStatusMessage(
  bot: Bot,
  userId: number,
  windowId: string,
  threadId: number | null = null,
): Promise<void> {
  const w = await tmuxManager.findWindowById(windowId)
  if (!w) {
    await enqueueStatusUpdate(bot, userId, windowId, null, { threadId: threadId ?? undefined })
    return
  }

  const paneText = await tmuxManager.capturPane(w.windowId)
  if (!paneText) return

  const interactiveWindow = getInteractiveWindow(userId, threadId)
  const hashKey = `${userId}:${windowId}`
  const hash = simpleHash(paneText)
  if (interactiveWindow === null && _paneHashes.get(hashKey) === hash) return
  _paneHashes.set(hashKey, hash)
  let shouldCheckNewUI = true

  if (interactiveWindow === windowId) {
    if (isInteractiveUI(paneText)) return
    // Interactive UI gone — clear mode, fall through to status check
    await clearInteractiveMsg(userId, bot, threadId)
    shouldCheckNewUI = false
  }
  else if (interactiveWindow !== null) {
    // User in interactive mode for different window — clear stale mode (force, not TTL-gated)
    await clearInteractiveMsg(userId, bot, threadId, true)
  }

  if (shouldCheckNewUI && isInteractiveUI(paneText)) {
    await handleInteractiveUI(bot, userId, windowId, threadId)
    return
  }

  const statusLine = parseStatusLine(paneText)
  if (statusLine) {
    await enqueueStatusUpdate(bot, userId, windowId, statusLine, {
      threadId: threadId ?? undefined,
    })
  }
}

export async function statusPollLoop(bot: Bot): Promise<void> {
  console.log(`Status polling started (interval: ${STATUS_POLL_INTERVAL}ms)`)
  let lastTopicCheck = 0

  while (true) {
    try {
      const now = Date.now()

      // Periodic topic existence probe
      if (now - lastTopicCheck >= TOPIC_CHECK_INTERVAL) {
        lastTopicCheck = now
        for (const [userId, threadId, wid] of [...sessionManager.iterThreadBindings()]) {
          try {
            const chatId = sessionManager.resolveChatId(userId, threadId)
            await bot.api.unpinAllForumTopicMessages(chatId, threadId)
          }
          catch (e) {
            if (
              e instanceof GrammyError
              && (e.description.includes("Topic_id_invalid") || e.error_code === 400)
            ) {
              const msg = e.description.toLowerCase()
              if (msg.includes("topic_id_invalid") || msg.includes("message thread not found")) {
                // Topic deleted — kill window, unbind, clean up state
                const w = await tmuxManager.findWindowById(wid)
                if (w) await tmuxManager.killWindow(w.windowId)
                sessionManager.unbindThread(userId, threadId)
                await clearTopicState(userId, threadId, bot)
                console.log(
                  `Topic deleted: killed window_id '${wid}' and unbound thread ${threadId} for user ${userId}`,
                )
              }
            }
          }
        }
      }

      // Status update for all bindings
      for (const [userId, threadId, wid] of [...sessionManager.iterThreadBindings()]) {
        try {
          const w = await tmuxManager.findWindowById(wid)
          if (!w) {
            // Window gone — clean up stale binding
            sessionManager.unbindThread(userId, threadId)
            await clearTopicState(userId, threadId, bot)
            console.log(`Cleaned up stale binding: user=${userId} thread=${threadId} window_id=${wid}`)
            continue
          }

          const queue = getMessageQueue(userId)
          if (queue && queue.length > 0) continue

          await updateStatusMessage(bot, userId, wid, threadId)
        }
        catch (e) {
          console.debug(`Status update error for user ${userId} thread ${threadId}: ${e}`)
        }
      }
    }
    catch (e) {
      console.error(`Status poll loop error: ${e}`)
    }

    await Bun.sleep(STATUS_POLL_INTERVAL)
  }
}
