/**
 * Message history display with pagination.
 *
 * Port of history.py. Provides history viewing for Claude Code sessions:
 *   - Paginated display with inline keyboard navigation
 *   - Full history and unread byte-range views
 *   - Respects config.showUserMessages filter
 */

import type { Api } from "grammy"
import type { InlineKeyboardMarkup } from "@grammyjs/types"
import { config } from "../config"
import { sessionManager } from "../session"
import { splitMessage } from "../utils"
import { TranscriptParser } from "../transcript"
import { CB_HISTORY_NEXT, CB_HISTORY_PREV } from "./callbackData"
import { safeEdit, safeSend } from "./messageSender"

function buildHistoryKeyboard(
  windowId: string,
  pageIndex: number,
  totalPages: number,
  startByte = 0,
  endByte = 0,
): InlineKeyboardMarkup | null {
  if (totalPages <= 1) return null

  const row: Array<{ text: string; callback_data: string }> = []

  if (pageIndex > 0) {
    const cb = `${CB_HISTORY_PREV}${pageIndex - 1}:${windowId}:${startByte}:${endByte}`
    row.push({ text: "◀ Older", callback_data: cb.slice(0, 64) })
  }

  row.push({ text: `${pageIndex + 1}/${totalPages}`, callback_data: "noop" })

  if (pageIndex < totalPages - 1) {
    const cb = `${CB_HISTORY_NEXT}${pageIndex + 1}:${windowId}:${startByte}:${endByte}`
    row.push({ text: "Newer ▶", callback_data: cb.slice(0, 64) })
  }

  return { inline_keyboard: [row] }
}

export interface SendHistoryOpts {
  bot: Api
  chatId: number
  windowId: string
  /** 0-based page index; -1 = last page (default) */
  offset?: number
  /** If true, edit existing message instead of sending new */
  edit?: boolean
  /** Message ID to edit (required if edit=true) */
  editMessageId?: number
  /** Byte range filter: start offset (0 = beginning) */
  startByte?: number
  /** Byte range filter: end offset (0 = to file end) */
  endByte?: number
  /** User ID for updating read offset */
  userId?: number
  /** Telegram topic thread_id */
  threadId?: number | null
}

export async function sendHistory(opts: SendHistoryOpts): Promise<void> {
  const {
    bot,
    chatId,
    windowId,
    offset = -1,
    edit = false,
    editMessageId,
    startByte = 0,
    endByte = 0,
    userId,
    threadId = null,
  } = opts

  const displayName = sessionManager.getDisplayName(windowId)
  const isUnread = startByte > 0 || endByte > 0
  const expStart = TranscriptParser.EXPANDABLE_QUOTE_START
  const expEnd = TranscriptParser.EXPANDABLE_QUOTE_END

  let [messages, total] = await sessionManager.getRecentMessages(windowId, {
    startByte,
    endByte: endByte > 0 ? endByte : null,
  })

  let text: string
  let keyboard: InlineKeyboardMarkup | null = null

  if (total === 0) {
    text = isUnread
      ? `📬 [${displayName}] No unread messages.`
      : `📋 [${displayName}] No messages yet.`
  }
  else {
    // Filter messages based on config
    if (!config.showUserMessages) {
      messages = messages.filter(m => (m as any).role === "assistant")
    }
    total = messages.length

    if (total === 0) {
      text = isUnread
        ? `📬 [${displayName}] No unread messages.`
        : `📋 [${displayName}] No messages yet.`

      if (edit && editMessageId != null) {
        await safeEdit(bot, chatId, editMessageId, text)
      }
      else {
        await safeSend(bot, chatId, text, {
          message_thread_id: threadId ?? undefined,
        })
      }
      if (userId != null && endByte > 0) {
        sessionManager.updateUserWindowOffset(userId, windowId, endByte)
      }
      return
    }

    const header = isUnread
      ? `📬 [${displayName}] ${total} unread messages`
      : `📋 [${displayName}] Messages (${total} total)`

    const lines: string[] = [header]

    for (const msg of messages) {
      const ts = (msg as any).timestamp as string | undefined
      let hhMm = ""
      if (ts) {
        try {
          const timePart = ts.includes("T") ? (ts.split("T")[1] ?? ts) : ts
          hhMm = timePart.slice(0, 5)
        }
        catch {}
      }

      lines.push(hhMm ? `───── ${hhMm} ─────` : "─────────────")

      let msgText = ((msg as any).text as string) ?? ""
      const contentType = ((msg as any).content_type as string) ?? "text"
      const msgRole = ((msg as any).role as string) ?? "assistant"

      // Strip expandable quote sentinels for history view
      msgText = msgText
        .split(expStart).join("")
        .split(expEnd).join("")

      if (msgRole === "user") {
        lines.push(`👤 ${msgText}`)
      }
      else if (contentType === "thinking") {
        lines.push(`∴ Thinking…\n${msgText}`)
      }
      else {
        lines.push(msgText)
      }
    }

    const fullText = lines.join("\n\n")
    const pages = splitMessage(fullText, 4096)
    const pageIndex = offset < 0 ? pages.length - 1 : Math.max(0, Math.min(offset, pages.length - 1))

    text = pages[pageIndex]!
    keyboard = buildHistoryKeyboard(windowId, pageIndex, pages.length, startByte, endByte)
  }

  if (edit && editMessageId != null) {
    await safeEdit(bot, chatId, editMessageId, text, {
      reply_markup: keyboard ?? undefined,
    })
  }
  else {
    await safeSend(bot, chatId, text, {
      message_thread_id: threadId ?? undefined,
      reply_markup: keyboard ?? undefined,
    })
  }

  // Update user's read offset after viewing unread
  if (isUnread && userId != null && endByte > 0) {
    sessionManager.updateUserWindowOffset(userId, windowId, endByte)
  }
}
