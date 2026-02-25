/**
 * Telegram bot handlers — the main UI layer of CCBot.
 *
 * Port of bot.py. Registers all command/callback/message handlers
 * and manages the bot lifecycle using Grammy.
 *
 * Each Telegram topic maps 1:1 to a tmux window (Claude session).
 *
 * Key functions: createBot(), handleNewMessage().
 */

import { Bot, GrammyError, InputFile } from "grammy"
import type { Context } from "grammy"
import { config } from "./config"
import { sessionManager } from "./session"
import { tmuxManager } from "./tmux"
import { SessionMonitor } from "./monitor"
import { parseUsageOutput, extractBashOutput } from "./terminal"
import { convertMarkdown } from "./markdown"
import { ccbotDir } from "./utils"
import { textToImage } from "./screenshot"
import type { NewMessage } from "./types"

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
  CB_DIR_CANCEL,
  CB_DIR_CONFIRM,
  CB_DIR_PAGE,
  CB_DIR_SELECT,
  CB_DIR_UP,
  CB_HISTORY_NEXT,
  CB_HISTORY_PREV,
  CB_KEYS_PREFIX,
  CB_SCREENSHOT_REFRESH,
  CB_WIN_BIND,
  CB_WIN_CANCEL,
  CB_WIN_NEW,
} from "./handlers/callbackData"
import {
  BROWSE_DIRS_KEY,
  BROWSE_PAGE_KEY,
  BROWSE_PATH_KEY,
  STATE_BROWSING_DIRECTORY,
  STATE_KEY,
  STATE_SELECTING_WINDOW,
  buildDirectoryBrowser,
  buildWindowPicker,
  clearBrowseState,
  clearWindowPickerState,
} from "./handlers/directoryBrowser"
import { clearTopicState } from "./handlers/cleanup"
import { sendHistory } from "./handlers/history"
import {
  INTERACTIVE_TOOL_NAMES,
  clearInteractiveMode,
  clearInteractiveMsg,
  getInteractiveMsgId,
  getInteractiveWindow,
  handleInteractiveUI,
  setInteractiveMode,
} from "./handlers/interactiveUI"
import {
  clearStatusMsgInfo,
  enqueueContentMessage,
  enqueueStatusUpdate,
  getMessageQueue,
  shutdownWorkers,
} from "./handlers/messageQueue"
import { NO_LINK_PREVIEW, safeReply, safeSend, sendWithFallback } from "./handlers/messageSender"
import { buildResponseParts } from "./handlers/responseBuilder"
import { statusPollLoop } from "./handlers/statusPolling"

import { resolve } from "path"
import { mkdirSync, statSync } from "fs"

// ---------------------------------------------------------------------------
// Per-user ephemeral state (replaces Python's context.user_data)
// ---------------------------------------------------------------------------

const _userData = new Map<number, Record<string, unknown>>()

function getUserData(userId: number): Record<string, unknown> {
  if (!_userData.has(userId)) _userData.set(userId, {})
  return _userData.get(userId)!
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let _sessionMonitor: SessionMonitor | null = null
let _statusPollTask: Promise<void> | null = null
let _statusPollAbort: AbortController | null = null

// Active bash capture tasks: key `${userId}:${threadId}` → AbortController
const _bashCaptureTasks = new Map<string, AbortController>()

// Images directory for incoming photos
const _imagesDir = resolve(ccbotDir(), "images")
mkdirSync(_imagesDir, { recursive: true })

// CC commands forwarded to Claude Code
const CC_COMMANDS: Record<string, string> = {
  clear: "↗ Clear conversation history",
  compact: "↗ Compact conversation context",
  cost: "↗ Show token/cost usage",
  help: "↗ Show Claude Code help",
  memory: "↗ Edit CLAUDE.md",
  model: "↗ Switch AI model",
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isUserAllowed(userId: number | undefined | null): boolean {
  return userId != null && config.isUserAllowed(userId)
}

function getThreadId(ctx: Context): number | null {
  const msg = ctx.message ?? ctx.callbackQuery?.message
  if (!msg) return null
  const tid = msg.message_thread_id
  if (tid == null || tid === 1) return null
  return tid
}

function captureGroupChatId(ctx: Context, userId: number, threadId: number | null): void {
  const chat = ctx.chat
  if (chat && (chat.type === "group" || chat.type === "supergroup")) {
    sessionManager.setGroupChatId(userId, threadId, chat.id)
  }
}

// ---------------------------------------------------------------------------
// Screenshot keyboard
// ---------------------------------------------------------------------------

type KeyInfo = [string, boolean, boolean] // [tmuxKey, enter, literal]

const KEYS_SEND_MAP: Record<string, KeyInfo> = {
  up: ["Up", false, false],
  dn: ["Down", false, false],
  lt: ["Left", false, false],
  rt: ["Right", false, false],
  esc: ["Escape", false, false],
  ent: ["Enter", false, false],
  spc: ["Space", false, false],
  tab: ["Tab", false, false],
  cc: ["C-c", false, false],
}

const KEY_LABELS: Record<string, string> = {
  up: "↑",
  dn: "↓",
  lt: "←",
  rt: "→",
  esc: "⎋ Esc",
  ent: "⏎ Enter",
  spc: "␣ Space",
  tab: "⇥ Tab",
  cc: "^C",
}

function buildScreenshotKeyboard(windowId: string) {
  const btn = (label: string, keyId: string) => ({
    text: label,
    callback_data: `${CB_KEYS_PREFIX}${keyId}:${windowId}`.slice(0, 64),
  })
  return {
    inline_keyboard: [
      [btn("␣ Space", "spc"), btn("↑", "up"), btn("⇥ Tab", "tab")],
      [btn("←", "lt"), btn("↓", "dn"), btn("→", "rt")],
      [btn("⎋ Esc", "esc"), btn("^C", "cc"), btn("⏎ Enter", "ent")],
      [{ text: "🔄 Refresh", callback_data: `${CB_SCREENSHOT_REFRESH}${windowId}`.slice(0, 64) }],
    ],
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function startCommand(ctx: Context): Promise<void> {
  const user = ctx.from
  if (!user || !isUserAllowed(user.id)) {
    await ctx.api.sendMessage(ctx.chat!.id, "You are not authorized to use this bot.")
    return
  }
  clearBrowseState(getUserData(user.id))
  const chatId = ctx.chat!.id
  const threadId = getThreadId(ctx)
  await safeReply(ctx.api as any, chatId, "🤖 *Claude Code Monitor*\n\nEach topic is a session. Create a new topic to start.", {
    message_thread_id: threadId ?? undefined,
  })
}

async function historyCommand(ctx: Context): Promise<void> {
  const user = ctx.from
  if (!user || !isUserAllowed(user.id)) return
  const chatId = ctx.chat!.id
  const threadId = getThreadId(ctx)
  const wid = sessionManager.resolveWindowForThread(user.id, threadId)
  if (!wid) {
    await safeSend(ctx.api as any, chatId, "❌ No session bound to this topic.", {
      message_thread_id: threadId ?? undefined,
    })
    return
  }
  await sendHistory({ bot: ctx.api as any, chatId, windowId: wid, threadId, userId: user.id })
}

async function screenshotCommand(ctx: Context): Promise<void> {
  const user = ctx.from
  if (!user || !isUserAllowed(user.id)) return
  const chatId = ctx.chat!.id
  const threadId = getThreadId(ctx)

  const wid = sessionManager.resolveWindowForThread(user.id, threadId)
  if (!wid) {
    await safeSend(ctx.api as any, chatId, "❌ No session bound to this topic.", {
      message_thread_id: threadId ?? undefined,
    })
    return
  }

  const w = await tmuxManager.findWindowById(wid)
  if (!w) {
    const display = sessionManager.getDisplayName(wid)
    await safeSend(ctx.api as any, chatId, `❌ Window '${display}' no longer exists.`, {
      message_thread_id: threadId ?? undefined,
    })
    return
  }

  const text = await tmuxManager.capturPane(w.windowId, true)
  if (!text) {
    await safeSend(ctx.api as any, chatId, "❌ Failed to capture pane content.", {
      message_thread_id: threadId ?? undefined,
    })
    return
  }

  const bytes = await textToImage(text, true)
  const keyboard = buildScreenshotKeyboard(wid)
  await ctx.api.sendDocument(chatId, new InputFile(bytes, "screenshot.txt"), {
    reply_markup: keyboard,
    message_thread_id: threadId ?? undefined,
  } as any)
}

async function unbindCommand(ctx: Context): Promise<void> {
  const user = ctx.from
  if (!user || !isUserAllowed(user.id)) return
  const chatId = ctx.chat!.id
  const threadId = getThreadId(ctx)

  if (threadId == null) {
    await safeSend(ctx.api as any, chatId, "❌ This command only works in a topic.")
    return
  }

  const wid = sessionManager.getWindowForThread(user.id, threadId)
  if (!wid) {
    await safeSend(ctx.api as any, chatId, "❌ No session bound to this topic.", {
      message_thread_id: threadId,
    })
    return
  }

  const display = sessionManager.getDisplayName(wid)
  sessionManager.unbindThread(user.id, threadId)
  await clearTopicState(user.id, threadId, ctx.api as any)

  await safeSend(
    ctx.api as any,
    chatId,
    `✅ Topic unbound from window '${display}'.\nThe Claude session is still running in tmux.\nSend a message to bind to a new session.`,
    { message_thread_id: threadId },
  )
}

async function escCommand(ctx: Context): Promise<void> {
  const user = ctx.from
  if (!user || !isUserAllowed(user.id)) return
  const chatId = ctx.chat!.id
  const threadId = getThreadId(ctx)

  const wid = sessionManager.resolveWindowForThread(user.id, threadId)
  if (!wid) {
    await safeSend(ctx.api as any, chatId, "❌ No session bound to this topic.", {
      message_thread_id: threadId ?? undefined,
    })
    return
  }

  const w = await tmuxManager.findWindowById(wid)
  if (!w) {
    const display = sessionManager.getDisplayName(wid)
    await safeSend(ctx.api as any, chatId, `❌ Window '${display}' no longer exists.`, {
      message_thread_id: threadId ?? undefined,
    })
    return
  }

  await tmuxManager.sendKeys(w.windowId, "\x1b", false, false)
  await safeSend(ctx.api as any, chatId, "⎋ Sent Escape", { message_thread_id: threadId ?? undefined })
}

async function killCommand(ctx: Context): Promise<void> {
  const user = ctx.from
  if (!user || !isUserAllowed(user.id)) return
  const chatId = ctx.chat!.id
  const threadId = getThreadId(ctx)

  if (threadId == null) {
    await safeSend(ctx.api as any, chatId, "❌ This command only works in a topic.")
    return
  }

  const wid = sessionManager.getWindowForThread(user.id, threadId)
  if (!wid) {
    await safeSend(ctx.api as any, chatId, "❌ No session bound to this topic.", {
      message_thread_id: threadId,
    })
    return
  }

  const display = sessionManager.getDisplayName(wid)
  const w = await tmuxManager.findWindowById(wid)
  if (w) {
    await tmuxManager.killWindow(w.windowId)
  }
  sessionManager.unbindThread(user.id, threadId)
  await clearTopicState(user.id, threadId, ctx.api as any)

  // Try to close the Telegram forum topic
  try {
    await ctx.api.closeForumTopic(chatId, threadId)
  }
  catch {}

  await safeSend(
    ctx.api as any,
    chatId,
    `✅ Session '${display}' killed and topic closed.`,
    { message_thread_id: threadId },
  )
}

async function usageCommand(ctx: Context): Promise<void> {
  const user = ctx.from
  if (!user || !isUserAllowed(user.id)) return
  const chatId = ctx.chat!.id
  const threadId = getThreadId(ctx)

  const wid = sessionManager.resolveWindowForThread(user.id, threadId)
  if (!wid) {
    await safeSend(ctx.api as any, chatId, "No session bound to this topic.", {
      message_thread_id: threadId ?? undefined,
    })
    return
  }

  const w = await tmuxManager.findWindowById(wid)
  if (!w) {
    await safeSend(ctx.api as any, chatId, `Window '${wid}' no longer exists.`, {
      message_thread_id: threadId ?? undefined,
    })
    return
  }

  await tmuxManager.sendKeys(w.windowId, "/usage")
  await Bun.sleep(2000)
  const paneText = await tmuxManager.capturPane(w.windowId)
  await tmuxManager.sendKeys(w.windowId, "Escape", false, false)

  if (!paneText) {
    await safeSend(ctx.api as any, chatId, "Failed to capture usage info.", {
      message_thread_id: threadId ?? undefined,
    })
    return
  }

  const usage = parseUsageOutput(paneText)
  if (usage?.parsedLines.length) {
    const text = usage.parsedLines.join("\n")
    await safeSend(ctx.api as any, chatId, `\`\`\`\n${text}\n\`\`\``, {
      message_thread_id: threadId ?? undefined,
    })
  }
  else {
    const trimmed = paneText.trim().slice(0, 3000)
    await safeSend(ctx.api as any, chatId, `\`\`\`\n${trimmed}\n\`\`\``, {
      message_thread_id: threadId ?? undefined,
    })
  }
}

// ---------------------------------------------------------------------------
// Topic closed handler
// ---------------------------------------------------------------------------

async function topicClosedHandler(ctx: Context): Promise<void> {
  const user = ctx.from
  if (!user || !isUserAllowed(user.id)) return
  const chatId = ctx.chat!.id
  const threadId = getThreadId(ctx)
  if (threadId == null) return

  const wid = sessionManager.getWindowForThread(user.id, threadId)
  if (wid) {
    const display = sessionManager.getDisplayName(wid)
    const w = await tmuxManager.findWindowById(wid)
    if (w) {
      await tmuxManager.killWindow(w.windowId)
      console.log(`Topic closed: killed window ${display} (user=${user.id}, thread=${threadId})`)
    }
    sessionManager.unbindThread(user.id, threadId)
    await clearTopicState(user.id, threadId, ctx.api as any)
  }
}

// ---------------------------------------------------------------------------
// Forward command handler
// ---------------------------------------------------------------------------

async function forwardCommandHandler(ctx: Context): Promise<void> {
  const user = ctx.from
  if (!user || !isUserAllowed(user.id)) return
  const chatId = ctx.chat!.id
  const threadId = getThreadId(ctx)

  captureGroupChatId(ctx, user.id, threadId)

  const cmdText = ctx.message?.text ?? ""
  const ccSlash = cmdText.split("@")[0] ?? ""

  const wid = sessionManager.resolveWindowForThread(user.id, threadId)
  if (!wid) {
    await safeSend(ctx.api as any, chatId, "❌ No session bound to this topic.", {
      message_thread_id: threadId ?? undefined,
    })
    return
  }

  const w = await tmuxManager.findWindowById(wid)
  if (!w) {
    const display = sessionManager.getDisplayName(wid)
    await safeSend(ctx.api as any, chatId, `❌ Window '${display}' no longer exists.`, {
      message_thread_id: threadId ?? undefined,
    })
    return
  }

  const display = sessionManager.getDisplayName(wid)
  console.log(`Forwarding command ${ccSlash} to window ${display} (user=${user.id})`)
  try { await ctx.api.sendChatAction(chatId, "typing") } catch {}

  const [success, message] = await sessionManager.sendToWindow(wid, ccSlash)
  if (success) {
    await safeSend(ctx.api as any, chatId, `⚡ [${display}] Sent: ${ccSlash}`, {
      message_thread_id: threadId ?? undefined,
    })
    if (ccSlash.trim().toLowerCase() === "/clear") {
      sessionManager.clearWindowSession(wid)
    }
  }
  else {
    await safeSend(ctx.api as any, chatId, `❌ ${message}`, {
      message_thread_id: threadId ?? undefined,
    })
  }
}

// ---------------------------------------------------------------------------
// Unsupported content handler
// ---------------------------------------------------------------------------

async function unsupportedContentHandler(ctx: Context): Promise<void> {
  const user = ctx.from
  if (!user || !isUserAllowed(user.id)) return
  const chatId = ctx.chat!.id
  const threadId = getThreadId(ctx)
  await safeSend(
    ctx.api as any,
    chatId,
    "⚠ Only text messages are supported. Images, stickers, voice, and other media cannot be forwarded to Claude Code.",
    { message_thread_id: threadId ?? undefined },
  )
}

// ---------------------------------------------------------------------------
// Photo handler
// ---------------------------------------------------------------------------

async function photoHandler(ctx: Context): Promise<void> {
  const user = ctx.from
  if (!user || !isUserAllowed(user.id)) {
    const chatId = ctx.chat?.id
    if (chatId) await ctx.api.sendMessage(chatId, "You are not authorized to use this bot.")
    return
  }

  const msg = ctx.message
  if (!msg?.photo?.length) return

  const chatId = ctx.chat!.id
  const threadId = getThreadId(ctx)
  captureGroupChatId(ctx, user.id, threadId)

  if (threadId == null) {
    await safeSend(
      ctx.api as any,
      chatId,
      "❌ Please use a named topic. Create a new topic to start a session.",
    )
    return
  }

  const wid = sessionManager.getWindowForThread(user.id, threadId)
  if (!wid) {
    await safeSend(ctx.api as any, chatId, "❌ No session bound to this topic. Send a text message first to create one.", {
      message_thread_id: threadId,
    })
    return
  }

  const w = await tmuxManager.findWindowById(wid)
  if (!w) {
    const display = sessionManager.getDisplayName(wid)
    sessionManager.unbindThread(user.id, threadId)
    await safeSend(ctx.api as any, chatId, `❌ Window '${display}' no longer exists. Binding removed.\nSend a message to start a new session.`, {
      message_thread_id: threadId,
    })
    return
  }

  // Download highest-resolution photo
  const photo = msg.photo[msg.photo.length - 1]!
  const tgFile = await ctx.api.getFile(photo.file_id)
  if (!tgFile.file_path) {
    await safeSend(ctx.api as any, chatId, "❌ Failed to get file path.", { message_thread_id: threadId })
    return
  }

  const filename = `${Date.now()}_${photo.file_unique_id}.jpg`
  const filePath = resolve(_imagesDir, filename)

  // Download file using fetch
  const token = config.telegramBotToken
  const fileUrl = `https://api.telegram.org/file/bot${token}/${tgFile.file_path}`
  try {
    const resp = await fetch(fileUrl)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const bytes = await resp.arrayBuffer()
    await Bun.write(filePath, bytes)
  }
  catch (e) {
    await safeSend(ctx.api as any, chatId, `❌ Failed to download image: ${e}`, { message_thread_id: threadId })
    return
  }

  const caption = msg.caption ?? ""
  const textToSend = caption
    ? `${caption}\n\n(image attached: ${filePath})`
    : `(image attached: ${filePath})`

  try { await ctx.api.sendChatAction(chatId, "typing") } catch {}
  clearStatusMsgInfo(user.id, threadId)

  const [success, sendMsg] = await sessionManager.sendToWindow(wid, textToSend)
  if (!success) {
    await safeSend(ctx.api as any, chatId, `❌ ${sendMsg}`, { message_thread_id: threadId })
    return
  }

  await safeSend(ctx.api as any, chatId, "📷 Image sent to Claude Code.", { message_thread_id: threadId })
}

// ---------------------------------------------------------------------------
// Bash output capture
// ---------------------------------------------------------------------------

function bashCaptureKey(userId: number, threadId: number): string {
  return `${userId}:${threadId}`
}

function cancelBashCapture(userId: number, threadId: number): void {
  const key = bashCaptureKey(userId, threadId)
  const ctrl = _bashCaptureTasks.get(key)
  if (ctrl) {
    ctrl.abort()
    _bashCaptureTasks.delete(key)
  }
}

async function captureBashOutput(
  bot: Bot,
  userId: number,
  threadId: number,
  windowId: string,
  command: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    await Bun.sleep(2000)
    if (signal.aborted) return

    const chatId = sessionManager.resolveChatId(userId, threadId)
    let msgId: number | null = null
    let lastOutput = ""

    for (let i = 0; i < 30; i++) {
      if (signal.aborted) return

      const raw = await tmuxManager.capturPane(windowId)
      if (!raw) { await Bun.sleep(1000); continue }

      const output = extractBashOutput(raw, command)
      if (!output) { await Bun.sleep(1000); continue }
      if (output === lastOutput) { await Bun.sleep(1000); continue }

      lastOutput = output
      const display = output.length > 3800 ? "… " + output.slice(-3800) : output

      if (msgId == null) {
        const sent = await sendWithFallback(bot.api, chatId, display, { message_thread_id: threadId })
        if (sent) msgId = sent.message_id
      }
      else {
        try {
          await bot.api.editMessageText(chatId, msgId, convertMarkdown(display), {
            parse_mode: "MarkdownV2",
            link_preview_options: NO_LINK_PREVIEW,
          })
        }
        catch {
          try {
            await bot.api.editMessageText(chatId, msgId, display, {
              link_preview_options: NO_LINK_PREVIEW,
            })
          }
          catch {}
        }
      }

      await Bun.sleep(1000)
    }
  }
  catch {}
  finally {
    const key = bashCaptureKey(userId, threadId)
    _bashCaptureTasks.delete(key)
  }
}

// ---------------------------------------------------------------------------
// Text handler
// ---------------------------------------------------------------------------

async function textHandler(ctx: Context, bot: Bot): Promise<void> {
  const user = ctx.from
  if (!user || !isUserAllowed(user.id)) {
    const chatId = ctx.chat?.id
    if (chatId) await ctx.api.sendMessage(chatId, "You are not authorized to use this bot.")
    return
  }

  const msg = ctx.message
  if (!msg?.text) return

  const chatId = ctx.chat!.id
  const threadId = getThreadId(ctx)
  captureGroupChatId(ctx, user.id, threadId)

  const text = msg.text
  const userData = getUserData(user.id)

  // Ignore text in window picker mode (same thread)
  if (userData[STATE_KEY] === STATE_SELECTING_WINDOW) {
    const pendingTid = userData["_pending_thread_id"] as number | undefined
    if (pendingTid === threadId) {
      await safeSend(ctx.api as any, chatId, "Please use the window picker above, or tap Cancel.", {
        message_thread_id: threadId ?? undefined,
      })
      return
    }
    // Stale picker from different thread — clear
    clearWindowPickerState(userData)
    delete userData["_pending_thread_id"]
    delete userData["_pending_thread_text"]
  }

  // Ignore text in directory browsing mode (same thread)
  if (userData[STATE_KEY] === STATE_BROWSING_DIRECTORY) {
    const pendingTid = userData["_pending_thread_id"] as number | undefined
    if (pendingTid === threadId) {
      await safeSend(ctx.api as any, chatId, "Please use the directory browser above, or tap Cancel.", {
        message_thread_id: threadId ?? undefined,
      })
      return
    }
    // Stale browse from different thread — clear
    clearBrowseState(userData)
    delete userData["_pending_thread_id"]
    delete userData["_pending_thread_text"]
  }

  // Must be in a named topic
  if (threadId == null) {
    await safeSend(
      ctx.api as any,
      chatId,
      "❌ Please use a named topic. Create a new topic to start a session.",
    )
    return
  }

  const wid = sessionManager.getWindowForThread(user.id, threadId)

  if (wid == null) {
    // Unbound topic — check for unbound windows first
    const allWindows = await tmuxManager.listWindows()
    const boundIds = new Set([...sessionManager.iterThreadBindings()].map(([, , w]) => w))
    const unbound = allWindows
      .filter(w => !boundIds.has(w.windowId))
      .map(w => [w.windowId, w.windowName, w.cwd] as [string, string, string])

    if (unbound.length > 0) {
      const [msgText, keyboard] = buildWindowPicker(unbound)
      userData[STATE_KEY] = STATE_SELECTING_WINDOW
      userData["_pending_thread_id"] = threadId
      userData["_pending_thread_text"] = text
      await safeSend(ctx.api as any, chatId, msgText, {
        message_thread_id: threadId,
        reply_markup: keyboard,
      })
      return
    }

    // No unbound windows — show directory browser
    const startPath = process.cwd()
    const [msgText, keyboard, subdirs] = buildDirectoryBrowser(startPath)
    userData[STATE_KEY] = STATE_BROWSING_DIRECTORY
    userData[BROWSE_PATH_KEY] = startPath
    userData[BROWSE_PAGE_KEY] = 0
    userData[BROWSE_DIRS_KEY] = subdirs
    userData["_pending_thread_id"] = threadId
    userData["_pending_thread_text"] = text
    await safeSend(ctx.api as any, chatId, msgText, {
      message_thread_id: threadId,
      reply_markup: keyboard,
    })
    return
  }

  // Bound topic — forward to bound window
  const w = await tmuxManager.findWindowById(wid)
  if (!w) {
    const display = sessionManager.getDisplayName(wid)
    sessionManager.unbindThread(user.id, threadId)
    await safeSend(
      ctx.api as any,
      chatId,
      `❌ Window '${display}' no longer exists. Binding removed.\nSend a message to start a new session.`,
      { message_thread_id: threadId },
    )
    return
  }

  try { await ctx.api.sendChatAction(chatId, "typing") } catch {}
  await enqueueStatusUpdate(bot, user.id, wid, null, { threadId })

  // Cancel any running bash capture — new message pushes pane content down
  cancelBashCapture(user.id, threadId)

  const [success, errMsg] = await sessionManager.sendToWindow(wid, text)
  if (!success) {
    await safeSend(ctx.api as any, chatId, `❌ ${errMsg}`, { message_thread_id: threadId })
    return
  }

  // Start background capture for ! bash command output
  if (text.startsWith("!") && text.length > 1) {
    const bashCmd = text.slice(1)
    const ctrl = new AbortController()
    const key = bashCaptureKey(user.id, threadId)
    _bashCaptureTasks.set(key, ctrl)
    captureBashOutput(bot, user.id, threadId, wid, bashCmd, ctrl.signal).catch(() => {})
  }

  // If in interactive mode, refresh UI after sending text
  const interactiveWindow = getInteractiveWindow(user.id, threadId)
  if (interactiveWindow && interactiveWindow === wid) {
    await Bun.sleep(200)
    await handleInteractiveUI(bot, user.id, wid, threadId)
  }
}

// ---------------------------------------------------------------------------
// Callback handler
// ---------------------------------------------------------------------------

async function callbackHandler(ctx: Context, bot: Bot): Promise<void> {
  const query = ctx.callbackQuery
  if (!query?.data) return

  const user = ctx.from
  if (!user || !isUserAllowed(user.id)) {
    await ctx.answerCallbackQuery("Not authorized")
    return
  }

  const data = query.data
  const chatId = ctx.chat?.id ?? query.message?.chat.id ?? user.id
  const msgId = query.message?.message_id

  const cbThreadId = getThreadId(ctx)
  captureGroupChatId(ctx, user.id, cbThreadId)
  const userData = getUserData(user.id)

  // --- History pagination ---
  if (data.startsWith(CB_HISTORY_PREV) || data.startsWith(CB_HISTORY_NEXT)) {
    const prefixLen = CB_HISTORY_PREV.length
    const rest = data.slice(prefixLen)
    try {
      const parts = rest.split(":")
      let offsetStr: string
      let windowId: string
      let startByte = 0
      let endByte = 0

      if (parts.length < 4) {
        const [off, wid] = rest.split(":", 2)
        offsetStr = off ?? ""
        windowId = wid ?? ""
      }
      else {
        offsetStr = parts[0]!
        startByte = parseInt(parts[parts.length - 2]!)
        endByte = parseInt(parts[parts.length - 1]!)
        windowId = parts.slice(1, parts.length - 2).join(":")
      }
      const offset = parseInt(offsetStr)

      const w = await tmuxManager.findWindowById(windowId)
      if (w) {
        await sendHistory({
          bot: bot.api,
          chatId,
          windowId,
          offset,
          edit: true,
          editMessageId: msgId,
          startByte,
          endByte,
        })
      }
      else {
        if (msgId) await bot.api.editMessageText(chatId, msgId, "Window no longer exists.", { link_preview_options: NO_LINK_PREVIEW })
      }
    }
    catch {
      await ctx.answerCallbackQuery("Invalid data")
      return
    }
    await ctx.answerCallbackQuery("Page updated")
    return
  }

  // --- Directory browser ---
  if (data.startsWith(CB_DIR_SELECT)) {
    const pendingTid = userData["_pending_thread_id"] as number | undefined
    if (pendingTid != null && cbThreadId !== pendingTid) {
      await ctx.answerCallbackQuery({ text: "Stale browser (topic mismatch)", show_alert: true })
      return
    }
    const idx = parseInt(data.slice(CB_DIR_SELECT.length))
    if (isNaN(idx)) { await ctx.answerCallbackQuery("Invalid data"); return }

    const cachedDirs = (userData[BROWSE_DIRS_KEY] as string[]) ?? []
    if (idx < 0 || idx >= cachedDirs.length) {
      await ctx.answerCallbackQuery({ text: "Directory list changed, please refresh", show_alert: true })
      return
    }

    const currentPath = (userData[BROWSE_PATH_KEY] as string) ?? process.cwd()
    const newPath = resolve(currentPath, cachedDirs[idx]!)
    if (!require("fs").existsSync(newPath)) {
      await ctx.answerCallbackQuery({ text: "Directory not found", show_alert: true })
      return
    }

    userData[BROWSE_PATH_KEY] = newPath
    userData[BROWSE_PAGE_KEY] = 0
    const [msgText, keyboard, subdirs] = buildDirectoryBrowser(newPath)
    userData[BROWSE_DIRS_KEY] = subdirs

    if (msgId) {
      try {
        await bot.api.editMessageText(chatId, msgId, convertMarkdown(msgText), {
          parse_mode: "MarkdownV2",
          reply_markup: keyboard,
          link_preview_options: NO_LINK_PREVIEW,
        })
      }
      catch {
        try {
          await bot.api.editMessageText(chatId, msgId, msgText, { reply_markup: keyboard, link_preview_options: NO_LINK_PREVIEW })
        }
        catch {}
      }
    }
    await ctx.answerCallbackQuery()
    return
  }

  if (data === CB_DIR_UP) {
    const pendingTid = userData["_pending_thread_id"] as number | undefined
    if (pendingTid != null && cbThreadId !== pendingTid) {
      await ctx.answerCallbackQuery({ text: "Stale browser (topic mismatch)", show_alert: true })
      return
    }
    const currentPath = (userData[BROWSE_PATH_KEY] as string) ?? process.cwd()
    const parentPath = resolve(currentPath, "..")
    userData[BROWSE_PATH_KEY] = parentPath
    userData[BROWSE_PAGE_KEY] = 0
    const [msgText, keyboard, subdirs] = buildDirectoryBrowser(parentPath)
    userData[BROWSE_DIRS_KEY] = subdirs
    if (msgId) {
      try {
        await bot.api.editMessageText(chatId, msgId, convertMarkdown(msgText), {
          parse_mode: "MarkdownV2",
          reply_markup: keyboard,
          link_preview_options: NO_LINK_PREVIEW,
        })
      }
      catch {
        try {
          await bot.api.editMessageText(chatId, msgId, msgText, { reply_markup: keyboard, link_preview_options: NO_LINK_PREVIEW })
        }
        catch {}
      }
    }
    await ctx.answerCallbackQuery()
    return
  }

  if (data.startsWith(CB_DIR_PAGE)) {
    const pendingTid = userData["_pending_thread_id"] as number | undefined
    if (pendingTid != null && cbThreadId !== pendingTid) {
      await ctx.answerCallbackQuery({ text: "Stale browser (topic mismatch)", show_alert: true })
      return
    }
    const pg = parseInt(data.slice(CB_DIR_PAGE.length))
    if (isNaN(pg)) { await ctx.answerCallbackQuery("Invalid data"); return }
    const currentPath = (userData[BROWSE_PATH_KEY] as string) ?? process.cwd()
    userData[BROWSE_PAGE_KEY] = pg
    const [msgText, keyboard, subdirs] = buildDirectoryBrowser(currentPath, pg)
    userData[BROWSE_DIRS_KEY] = subdirs
    if (msgId) {
      try {
        await bot.api.editMessageText(chatId, msgId, convertMarkdown(msgText), {
          parse_mode: "MarkdownV2",
          reply_markup: keyboard,
          link_preview_options: NO_LINK_PREVIEW,
        })
      }
      catch {
        try {
          await bot.api.editMessageText(chatId, msgId, msgText, { reply_markup: keyboard, link_preview_options: NO_LINK_PREVIEW })
        }
        catch {}
      }
    }
    await ctx.answerCallbackQuery()
    return
  }

  if (data === CB_DIR_CONFIRM) {
    const selectedPath = (userData[BROWSE_PATH_KEY] as string) ?? process.cwd()
    const pendingThreadId = userData["_pending_thread_id"] as number | undefined
    const confirmThreadId = cbThreadId

    if (pendingThreadId != null && confirmThreadId !== pendingThreadId) {
      clearBrowseState(userData)
      delete userData["_pending_thread_id"]
      delete userData["_pending_thread_text"]
      await ctx.answerCallbackQuery({ text: "Stale browser (topic mismatch)", show_alert: true })
      return
    }

    // Fall back to callback thread if state was lost (e.g. bot restarted mid-session)
    const effectiveThreadId = pendingThreadId ?? confirmThreadId

    clearBrowseState(userData)

    const [success, message, createdWname, createdWid] = await tmuxManager.createWindow(selectedPath, undefined, true)
    if (success && createdWid) {
      console.log(`Window created: ${createdWname} (id=${createdWid}) at ${selectedPath} (user=${user.id}, thread=${effectiveThreadId})`)
      await sessionManager.waitForSessionMapEntry(createdWid)

      if (effectiveThreadId != null) {
        sessionManager.bindThread(user.id, effectiveThreadId, createdWid, createdWname)
        const resolvedChat = sessionManager.resolveChatId(user.id, effectiveThreadId)
        try {
          await bot.api.editForumTopic(resolvedChat, effectiveThreadId, { name: createdWname })
        }
        catch (e) {
          console.debug(`Failed to rename topic: ${e}`)
        }

        if (msgId) {
          try {
            await bot.api.editMessageText(chatId, msgId, convertMarkdown(`✅ ${message}\n\nBound to this topic. Send messages here.`), {
              parse_mode: "MarkdownV2",
              link_preview_options: NO_LINK_PREVIEW,
            })
          }
          catch {
            try {
              await bot.api.editMessageText(chatId, msgId, `✅ ${message}\n\nBound to this topic. Send messages here.`, { link_preview_options: NO_LINK_PREVIEW })
            }
            catch {}
          }
        }

        const pendingText = userData["_pending_thread_text"] as string | undefined
        if (pendingText) {
          delete userData["_pending_thread_text"]
          delete userData["_pending_thread_id"]
          const [sendOk, sendMsg] = await sessionManager.sendToWindow(createdWid, pendingText)
          if (!sendOk) {
            await safeSend(bot.api, resolvedChat, `❌ Failed to send pending message: ${sendMsg}`, {
              message_thread_id: effectiveThreadId,
            })
          }
        }
        else {
          delete userData["_pending_thread_id"]
        }
      }
      else {
        if (msgId) {
          try {
            await bot.api.editMessageText(chatId, msgId, `✅ ${message}`, { link_preview_options: NO_LINK_PREVIEW })
          }
          catch {}
        }
      }
    }
    else {
      if (msgId) {
        try {
          await bot.api.editMessageText(chatId, msgId, `❌ ${message}`, { link_preview_options: NO_LINK_PREVIEW })
        }
        catch {}
      }
      if (pendingThreadId != null) {
        delete userData["_pending_thread_id"]
        delete userData["_pending_thread_text"]
      }
    }
    await ctx.answerCallbackQuery(success ? "Created" : "Failed")
    return
  }

  if (data === CB_DIR_CANCEL) {
    const pendingTid = userData["_pending_thread_id"] as number | undefined
    if (pendingTid != null && cbThreadId !== pendingTid) {
      await ctx.answerCallbackQuery({ text: "Stale browser (topic mismatch)", show_alert: true })
      return
    }
    clearBrowseState(userData)
    delete userData["_pending_thread_id"]
    delete userData["_pending_thread_text"]
    if (msgId) {
      try {
        await bot.api.editMessageText(chatId, msgId, "Cancelled", { link_preview_options: NO_LINK_PREVIEW })
      }
      catch {}
    }
    await ctx.answerCallbackQuery("Cancelled")
    return
  }

  // --- Window picker ---
  if (data.startsWith(CB_WIN_BIND)) {
    const pendingTid = userData["_pending_thread_id"] as number | undefined
    if (pendingTid != null && cbThreadId !== pendingTid) {
      await ctx.answerCallbackQuery({ text: "Stale picker (topic mismatch)", show_alert: true })
      return
    }
    // Window ID is encoded directly in callback_data (survives bot restarts)
    const selectedWid = data.slice(CB_WIN_BIND.length)
    if (!selectedWid) { await ctx.answerCallbackQuery("Invalid data"); return }

    const w = await tmuxManager.findWindowById(selectedWid)
    if (!w) {
      const display = sessionManager.getDisplayName(selectedWid)
      await ctx.answerCallbackQuery({ text: `Window '${display}' no longer exists`, show_alert: true })
      return
    }

    const threadId = cbThreadId
    if (threadId == null) {
      await ctx.answerCallbackQuery({ text: "Not in a topic", show_alert: true })
      return
    }

    const display = w.windowName
    clearWindowPickerState(userData)
    sessionManager.bindThread(user.id, threadId, selectedWid, display)

    const resolvedChat = sessionManager.resolveChatId(user.id, threadId)
    try {
      await bot.api.editForumTopic(resolvedChat, threadId, { name: display })
    }
    catch {}

    if (msgId) {
      try {
        await bot.api.editMessageText(chatId, msgId, convertMarkdown(`✅ Bound to window \`${display}\``), {
          parse_mode: "MarkdownV2",
          link_preview_options: NO_LINK_PREVIEW,
        })
      }
      catch {
        try {
          await bot.api.editMessageText(chatId, msgId, `✅ Bound to window '${display}'`, { link_preview_options: NO_LINK_PREVIEW })
        }
        catch {}
      }
    }

    const pendingText = userData["_pending_thread_text"] as string | undefined
    delete userData["_pending_thread_text"]
    delete userData["_pending_thread_id"]
    if (pendingText) {
      const [sendOk, sendMsg] = await sessionManager.sendToWindow(selectedWid, pendingText)
      if (!sendOk) {
        await safeSend(bot.api, resolvedChat, `❌ Failed to send pending message: ${sendMsg}`, {
          message_thread_id: threadId,
        })
      }
    }
    await ctx.answerCallbackQuery("Bound")
    return
  }

  if (data === CB_WIN_NEW) {
    const pendingTid = userData["_pending_thread_id"] as number | undefined
    if (pendingTid != null && cbThreadId !== pendingTid) {
      await ctx.answerCallbackQuery({ text: "Stale picker (topic mismatch)", show_alert: true })
      return
    }
    // Fall back to callback thread if state was lost (e.g. bot restarted mid-session)
    const effectiveTid = pendingTid ?? cbThreadId
    clearWindowPickerState(userData)
    const startPath = process.cwd()
    const [msgText, keyboard, subdirs] = buildDirectoryBrowser(startPath)
    userData[STATE_KEY] = STATE_BROWSING_DIRECTORY
    userData[BROWSE_PATH_KEY] = startPath
    userData[BROWSE_PAGE_KEY] = 0
    userData[BROWSE_DIRS_KEY] = subdirs
    // Preserve (or restore) the pending thread so CB_DIR_CONFIRM can bind correctly
    userData["_pending_thread_id"] = effectiveTid
    if (msgId) {
      try {
        await bot.api.editMessageText(chatId, msgId, convertMarkdown(msgText), {
          parse_mode: "MarkdownV2",
          reply_markup: keyboard,
          link_preview_options: NO_LINK_PREVIEW,
        })
      }
      catch {
        try {
          await bot.api.editMessageText(chatId, msgId, msgText, { reply_markup: keyboard, link_preview_options: NO_LINK_PREVIEW })
        }
        catch {}
      }
    }
    await ctx.answerCallbackQuery()
    return
  }

  if (data === CB_WIN_CANCEL) {
    const pendingTid = userData["_pending_thread_id"] as number | undefined
    if (pendingTid != null && cbThreadId !== pendingTid) {
      await ctx.answerCallbackQuery({ text: "Stale picker (topic mismatch)", show_alert: true })
      return
    }
    clearWindowPickerState(userData)
    delete userData["_pending_thread_id"]
    delete userData["_pending_thread_text"]
    if (msgId) {
      try {
        await bot.api.editMessageText(chatId, msgId, "Cancelled", { link_preview_options: NO_LINK_PREVIEW })
      }
      catch {}
    }
    await ctx.answerCallbackQuery("Cancelled")
    return
  }

  // --- Screenshot refresh ---
  if (data.startsWith(CB_SCREENSHOT_REFRESH)) {
    const windowId = data.slice(CB_SCREENSHOT_REFRESH.length)
    const w = await tmuxManager.findWindowById(windowId)
    if (!w) {
      await ctx.answerCallbackQuery({ text: "Window no longer exists", show_alert: true })
      return
    }

    const text = await tmuxManager.capturPane(w.windowId, true)
    if (!text) {
      await ctx.answerCallbackQuery({ text: "Failed to capture pane", show_alert: true })
      return
    }

    const bytes = await textToImage(text, true)
    const keyboard = buildScreenshotKeyboard(windowId)
    try {
      if (msgId) {
        await bot.api.editMessageMedia(chatId, msgId, {
          type: "document",
          media: new InputFile(bytes, "screenshot.txt"),
        } as any, { reply_markup: keyboard })
      }
      await ctx.answerCallbackQuery("Refreshed")
    }
    catch {
      await ctx.answerCallbackQuery({ text: "Failed to refresh", show_alert: true })
    }
    return
  }

  if (data === "noop") {
    await ctx.answerCallbackQuery()
    return
  }

  // --- Interactive UI controls ---
  if (data.startsWith(CB_ASK_UP)) {
    const windowId = data.slice(CB_ASK_UP.length)
    const tid = getThreadId(ctx)
    const w = await tmuxManager.findWindowById(windowId)
    if (w) {
      await tmuxManager.sendKeys(w.windowId, "Up", false, false)
      await Bun.sleep(500)
      await handleInteractiveUI(bot, user.id, windowId, tid)
    }
    await ctx.answerCallbackQuery()
    return
  }

  if (data.startsWith(CB_ASK_DOWN)) {
    const windowId = data.slice(CB_ASK_DOWN.length)
    const tid = getThreadId(ctx)
    const w = await tmuxManager.findWindowById(windowId)
    if (w) {
      await tmuxManager.sendKeys(w.windowId, "Down", false, false)
      await Bun.sleep(500)
      await handleInteractiveUI(bot, user.id, windowId, tid)
    }
    await ctx.answerCallbackQuery()
    return
  }

  if (data.startsWith(CB_ASK_LEFT)) {
    const windowId = data.slice(CB_ASK_LEFT.length)
    const tid = getThreadId(ctx)
    const w = await tmuxManager.findWindowById(windowId)
    if (w) {
      await tmuxManager.sendKeys(w.windowId, "Left", false, false)
      await Bun.sleep(500)
      await handleInteractiveUI(bot, user.id, windowId, tid)
    }
    await ctx.answerCallbackQuery()
    return
  }

  if (data.startsWith(CB_ASK_RIGHT)) {
    const windowId = data.slice(CB_ASK_RIGHT.length)
    const tid = getThreadId(ctx)
    const w = await tmuxManager.findWindowById(windowId)
    if (w) {
      await tmuxManager.sendKeys(w.windowId, "Right", false, false)
      await Bun.sleep(500)
      await handleInteractiveUI(bot, user.id, windowId, tid)
    }
    await ctx.answerCallbackQuery()
    return
  }

  if (data.startsWith(CB_ASK_ESC)) {
    const windowId = data.slice(CB_ASK_ESC.length)
    const tid = getThreadId(ctx)
    const w = await tmuxManager.findWindowById(windowId)
    if (w) {
      await tmuxManager.sendKeys(w.windowId, "Escape", false, false)
      await clearInteractiveMsg(user.id, bot, tid, true) // force: user explicitly pressed Esc
    }
    await ctx.answerCallbackQuery("⎋ Esc")
    return
  }

  if (data.startsWith(CB_ASK_ENTER)) {
    const windowId = data.slice(CB_ASK_ENTER.length)
    const tid = getThreadId(ctx)
    const w = await tmuxManager.findWindowById(windowId)
    if (w) {
      await tmuxManager.sendKeys(w.windowId, "Enter", false, false)
      await Bun.sleep(500)
      await handleInteractiveUI(bot, user.id, windowId, tid)
    }
    await ctx.answerCallbackQuery("⏎ Enter")
    return
  }

  if (data.startsWith(CB_ASK_SPACE)) {
    const windowId = data.slice(CB_ASK_SPACE.length)
    const tid = getThreadId(ctx)
    const w = await tmuxManager.findWindowById(windowId)
    if (w) {
      await tmuxManager.sendKeys(w.windowId, "Space", false, false)
      await Bun.sleep(500)
      await handleInteractiveUI(bot, user.id, windowId, tid)
    }
    await ctx.answerCallbackQuery("␣ Space")
    return
  }

  if (data.startsWith(CB_ASK_TAB)) {
    const windowId = data.slice(CB_ASK_TAB.length)
    const tid = getThreadId(ctx)
    const w = await tmuxManager.findWindowById(windowId)
    if (w) {
      await tmuxManager.sendKeys(w.windowId, "Tab", false, false)
      await Bun.sleep(500)
      await handleInteractiveUI(bot, user.id, windowId, tid)
    }
    await ctx.answerCallbackQuery("⇥ Tab")
    return
  }

  if (data.startsWith(CB_ASK_REFRESH)) {
    const windowId = data.slice(CB_ASK_REFRESH.length)
    const tid = getThreadId(ctx)
    await handleInteractiveUI(bot, user.id, windowId, tid)
    await ctx.answerCallbackQuery("🔄")
    return
  }

  // --- Screenshot quick keys ---
  if (data.startsWith(CB_KEYS_PREFIX)) {
    const rest = data.slice(CB_KEYS_PREFIX.length)
    const colonIdx = rest.indexOf(":")
    if (colonIdx < 0) { await ctx.answerCallbackQuery("Invalid data"); return }
    const keyId = rest.slice(0, colonIdx)
    const windowId = rest.slice(colonIdx + 1)

    const keyInfo = KEYS_SEND_MAP[keyId]
    if (!keyInfo) { await ctx.answerCallbackQuery("Unknown key"); return }

    const [tmuxKey, enter, literal] = keyInfo
    const w = await tmuxManager.findWindowById(windowId)
    if (!w) { await ctx.answerCallbackQuery({ text: "Window not found", show_alert: true }); return }

    await tmuxManager.sendKeys(w.windowId, tmuxKey, enter, literal)
    await ctx.answerCallbackQuery(KEY_LABELS[keyId] ?? keyId)

    // Refresh screenshot after key press
    await Bun.sleep(500)
    const text = await tmuxManager.capturPane(w.windowId, true)
    if (text && msgId) {
      const bytes = await textToImage(text, true)
      const keyboard = buildScreenshotKeyboard(windowId)
      try {
        await bot.api.editMessageMedia(chatId, msgId, {
          type: "document",
          media: new InputFile(bytes, "screenshot.txt"),
        } as any, { reply_markup: keyboard })
      }
      catch {}
    }
    return
  }
}

// ---------------------------------------------------------------------------
// New message handler (from session monitor)
// ---------------------------------------------------------------------------

export async function handleNewMessage(msg: NewMessage, bot: Bot): Promise<void> {
  const status = msg.isComplete ? "complete" : "streaming"
  console.log(
    `handle_new_message [${status}]: session=${msg.sessionId}, text_len=${msg.text.length}`,
  )

  const activeUsers = sessionManager.findUsersForSession(msg.sessionId)
  if (!activeUsers.length) {
    console.log(`No active users for session ${msg.sessionId}`)
    return
  }

  for (const [userId, wid, threadId] of activeUsers) {
    // Handle interactive tools specially
    if (msg.toolName && INTERACTIVE_TOOL_NAMES.has(msg.toolName) && msg.contentType === "tool_use") {
      setInteractiveMode(userId, wid, threadId)
      const queue = getMessageQueue(userId)
      if (queue) {
        // Wait for queue to drain
        const deadline = Date.now() + 5000
        while (queue.length > 0 && Date.now() < deadline) {
          await Bun.sleep(100)
        }
      }
      await Bun.sleep(300)
      const handled = await handleInteractiveUI(bot, userId, wid, threadId)
      if (handled) {
        const session = await sessionManager.resolveSessionForWindow(wid)
        if (session?.filePath) {
          try {
            const fileSize = statSync(session.filePath).size
            sessionManager.updateUserWindowOffset(userId, wid, fileSize)
          }
          catch {}
        }
        continue
      }
      else {
        clearInteractiveMode(userId, threadId)
      }
    }

    // Any non-interactive message means interaction is complete — delete UI message.
    // Do NOT force: respect the minimum TTL so the user sees the prompt long enough
    // to react before it disappears. (Esc, /kill, topic-close still force-clear.)
    if (getInteractiveMsgId(userId, threadId) != null) {
      await clearInteractiveMsg(userId, bot, threadId)
    }

    const parts = buildResponseParts(msg.text, msg.isComplete, msg.contentType, msg.role)

    if (msg.isComplete) {
      await enqueueContentMessage(bot, userId, wid, parts, {
        toolUseId: msg.toolUseId,
        contentType: msg.contentType,
        text: msg.text,
        threadId,
        imageData: msg.imageData,
      })

      // Update user's read offset
      const session = await sessionManager.resolveSessionForWindow(wid)
      if (session?.filePath) {
        try {
          const fileSize = statSync(session.filePath).size
          sessionManager.updateUserWindowOffset(userId, wid, fileSize)
        }
        catch {}
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Bot lifecycle
// ---------------------------------------------------------------------------

async function postInit(bot: Bot): Promise<void> {
  await bot.api.deleteMyCommands()

  const botCommands = [
    { command: "start", description: "Show welcome message" },
    { command: "history", description: "Message history for this topic" },
    { command: "screenshot", description: "Terminal screenshot with control keys" },
    { command: "esc", description: "Send Escape to interrupt Claude" },
    { command: "kill", description: "Kill session and delete topic" },
    { command: "unbind", description: "Unbind topic from session (keeps window running)" },
    { command: "usage", description: "Show Claude Code usage remaining" },
    ...Object.entries(CC_COMMANDS).map(([cmd, desc]) => ({ command: cmd, description: desc })),
  ]
  await bot.api.setMyCommands(botCommands)

  // Re-resolve stale window IDs from persisted state
  await sessionManager.resolveStaleIds()

  // Start session monitor
  const monitor = new SessionMonitor()
  monitor.setMessageCallback(async (msg: NewMessage) => {
    await handleNewMessage(msg, bot)
  })
  monitor.start()
  _sessionMonitor = monitor
  console.log("Session monitor started")

  // Start status polling
  _statusPollAbort = new AbortController()
  _statusPollTask = statusPollLoop(bot)
  console.log("Status polling task started")
}

async function postShutdown(): Promise<void> {
  _statusPollAbort?.abort()
  sessionManager.flushState()
  await shutdownWorkers()
  if (_sessionMonitor) {
    _sessionMonitor.stop()
    console.log("Session monitor stopped")
  }
}

export function createBot(): Bot {
  const bot = new Bot(config.telegramBotToken)

  // Error handling
  bot.catch(err => {
    console.error("Bot error:", err)
  })

  // Commands
  bot.command("start", startCommand)
  bot.command("history", historyCommand)
  bot.command("screenshot", screenshotCommand)
  bot.command("esc", escCommand)
  bot.command("kill", killCommand)
  bot.command("unbind", unbindCommand)
  bot.command("usage", usageCommand)

  // Callback queries
  bot.on("callback_query", async ctx => {
    await callbackHandler(ctx, bot)
  })

  // Topic closed
  bot.on("message:forum_topic_closed", topicClosedHandler)

  // Photos (before text handler)
  bot.on("message:photo", photoHandler)

  // Text: slash commands → forward; plain text → text handler
  bot.on("message:text", async ctx => {
    const text = ctx.message.text ?? ""
    if (text.startsWith("/")) {
      // Commands registered above are handled; any other "/" is forwarded
      await forwardCommandHandler(ctx)
    }
    else {
      await textHandler(ctx, bot)
    }
  })

  // Catch-all for unsupported content types
  bot.on("message", async ctx => {
    if (
      !ctx.message.text
      && !ctx.message.photo
      && !ctx.message.forum_topic_closed
      && !ctx.message.forum_topic_created
      && !ctx.message.forum_topic_edited
      && !ctx.message.forum_topic_reopened
    ) {
      await unsupportedContentHandler(ctx)
    }
  })

  return bot
}

export { postInit, postShutdown }
