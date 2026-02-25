/**
 * Interactive UI handling for Claude Code prompts.
 *
 * Handles AskUserQuestion, ExitPlanMode, PermissionPrompt, RestoreCheckpoint.
 * Sends inline keyboard for terminal navigation.
 */

import type { Bot } from "grammy"
import type { InlineKeyboardMarkup } from "@grammyjs/types"
import { sessionManager } from "../session"
import { extractInteractiveContent, isInteractiveUI } from "../terminal"
import { tmuxManager } from "../tmux"
import { NO_LINK_PREVIEW } from "./messageSender"
import {
  CB_ASK_DOWN,
  CB_ASK_ENTER,
  CB_ASK_ESC,
  CB_ASK_LEFT,
  CB_ASK_REFRESH,
  CB_ASK_RIGHT,
  CB_ASK_SPACE,
  CB_ASK_TAB,
  CB_ASK_UP,
} from "./callbackData"

export const INTERACTIVE_TOOL_NAMES = new Set(["AskUserQuestion", "ExitPlanMode"])

/** Minimum ms an interactive UI message stays alive before it can be deleted. */
const INTERACTIVE_MSG_MIN_TTL_MS = 10_000

// (userId, threadId) → message_id
const _interactiveMsgs = new Map<string, number>()
// (userId, threadId) → window_id
const _interactiveMode = new Map<string, string>()
// (userId, threadId) → sent-at timestamp (ms)
const _interactiveMsgSentAt = new Map<string, number>()

function ikey(userId: number, threadId: number | null): string {
  return `${userId}:${threadId ?? 0}`
}

export function getInteractiveWindow(userId: number, threadId: number | null): string | null {
  return _interactiveMode.get(ikey(userId, threadId)) ?? null
}

export function setInteractiveMode(userId: number, windowId: string, threadId: number | null): void {
  _interactiveMode.set(ikey(userId, threadId), windowId)
}

export function clearInteractiveMode(userId: number, threadId: number | null): void {
  _interactiveMode.delete(ikey(userId, threadId))
}

export function getInteractiveMsgId(userId: number, threadId: number | null): number | null {
  return _interactiveMsgs.get(ikey(userId, threadId)) ?? null
}

function buildInteractiveKeyboard(windowId: string, uiName = ""): InlineKeyboardMarkup {
  const verticalOnly = uiName === "RestoreCheckpoint"

  const btn = (label: string, prefix: string) => ({
    text: label,
    callback_data: (prefix + windowId).slice(0, 64),
  })

  const rows: Array<Array<{ text: string; callback_data: string }>> = []

  rows.push([
    btn("␣ Space", CB_ASK_SPACE),
    btn("↑", CB_ASK_UP),
    btn("⇥ Tab", CB_ASK_TAB),
  ])

  if (verticalOnly) {
    rows.push([btn("↓", CB_ASK_DOWN)])
  }
  else {
    rows.push([
      btn("←", CB_ASK_LEFT),
      btn("↓", CB_ASK_DOWN),
      btn("→", CB_ASK_RIGHT),
    ])
  }

  rows.push([
    btn("⎋ Esc", CB_ASK_ESC),
    btn("🔄", CB_ASK_REFRESH),
    btn("⏎ Enter", CB_ASK_ENTER),
  ])

  return { inline_keyboard: rows }
}

export async function handleInteractiveUI(
  bot: Bot,
  userId: number,
  windowId: string,
  threadId: number | null,
): Promise<boolean> {
  const ik = ikey(userId, threadId)
  const chatId = sessionManager.resolveChatId(userId, threadId)

  const w = await tmuxManager.findWindowById(windowId)
  if (!w) return false

  const paneText = await tmuxManager.capturPane(w.windowId)
  if (!paneText) return false

  if (!isInteractiveUI(paneText)) return false

  const content = extractInteractiveContent(paneText)
  if (!content) return false

  const keyboard = buildInteractiveKeyboard(windowId, content.name)
  const text = content.content

  const threadOpts = threadId != null ? { message_thread_id: threadId } : {}

  const existingMsgId = _interactiveMsgs.get(ik)
  if (existingMsgId) {
    try {
      await bot.api.editMessageText(chatId, existingMsgId, text, {
        reply_markup: keyboard,
        link_preview_options: NO_LINK_PREVIEW,
      })
      _interactiveMode.set(ik, windowId)
      return true
    }
    catch {
      // Message unchanged or too old — don't send new
      return true
    }
  }

  try {
    const sent = await bot.api.sendMessage(chatId, text, {
      reply_markup: keyboard,
      link_preview_options: NO_LINK_PREVIEW,
      ...threadOpts,
    })
    if (sent) {
      _interactiveMsgs.set(ik, sent.message_id)
      _interactiveMode.set(ik, windowId)
      _interactiveMsgSentAt.set(ik, Date.now()) // record when first sent
      return true
    }
  }
  catch (e) {
    console.error("Failed to send interactive UI:", e)
  }
  return false
}

export async function clearInteractiveMsg(
  userId: number,
  bot: Bot | null,
  threadId: number | null,
  force = false,
): Promise<void> {
  const ik = ikey(userId, threadId)
  const msgId = _interactiveMsgs.get(ik)

  // Respect minimum TTL — if message was just sent, don't delete yet.
  // Keep maps intact so the next status poll will retry.
  // Pass force=true to bypass TTL (e.g., /kill, topic close, /unbind).
  if (!force) {
    const sentAt = _interactiveMsgSentAt.get(ik)
    if (sentAt != null && (Date.now() - sentAt) < INTERACTIVE_MSG_MIN_TTL_MS) {
      return
    }
  }

  _interactiveMsgs.delete(ik)
  _interactiveMode.delete(ik)
  _interactiveMsgSentAt.delete(ik)

  if (bot && msgId != null) {
    const chatId = sessionManager.resolveChatId(userId, threadId)
    try { await bot.api.deleteMessage(chatId, msgId) } catch {}
  }
}
