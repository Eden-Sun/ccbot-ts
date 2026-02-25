/**
 * Per-user message queue management for ordered message delivery.
 *
 * Ensures messages are sent in FIFO order with:
 * - Consecutive content task merging for efficiency
 * - Tool use/result editing (tool_use message edited with result)
 * - Status message tracking and conversion
 * - Flood control (429 handling)
 * - Thread-aware sending for Telegram topics
 */

import type { Bot } from "grammy"
import {
  isRetryAfter,
  getRetryAfter,
  sendWithFallback,
  sendPhoto,
  NO_LINK_PREVIEW,
} from "./messageSender"
import { convertMarkdown, stripSentinels } from "../markdown"
import { TranscriptParser } from "../transcript"
import { sessionManager } from "../session"
import { parseStatusLine } from "../terminal"
import { tmuxManager } from "../tmux"
import type { MessageTask } from "../types"

const MERGE_MAX_LENGTH = 3800
const FLOOD_CONTROL_MAX_WAIT = 10

// Per-user queues: simple async queues
const _queues = new Map<number, MessageTask[]>()
const _workers = new Map<number, boolean>() // true = running
const _processingLock = new Map<number, boolean>()

// tool_use_id → message_id (for editing)
const _toolMsgIds = new Map<string, number>() // key: `${toolUseId}:${userId}:${threadId}`

// Status message tracking: key `${userId}:${threadId}` → [msgId, windowId, lastText]
const _statusMsgInfo = new Map<string, [number, string, string]>()

// Flood control: userId → monotonic time when ban expires
const _floodUntil = new Map<number, number>()

function toolKey(toolUseId: string, userId: number, threadId: number): string {
  return `${toolUseId}:${userId}:${threadId}`
}

function statusKey(userId: number, threadId: number): string {
  return `${userId}:${threadId}`
}

function threadKwargs(threadId: number | undefined): { message_thread_id?: number } {
  return threadId != null ? { message_thread_id: threadId } : {}
}

export function getMessageQueue(userId: number): MessageTask[] | undefined {
  return _queues.get(userId)
}

export function getOrCreateQueue(bot: Bot, userId: number): void {
  if (!_queues.has(userId)) {
    _queues.set(userId, [])
  }
  if (!_workers.get(userId)) {
    _workers.set(userId, true)
    _runWorker(bot, userId).catch(e => console.error("Queue worker error:", e))
  }
}

async function _runWorker(bot: Bot, userId: number): Promise<void> {
  while (true) {
    const queue = _queues.get(userId)
    if (!queue || queue.length === 0) {
      _workers.delete(userId)
      return
    }

    const task = queue.shift()!

    try {
      // Flood control
      const floodEnd = _floodUntil.get(userId) ?? 0
      if (floodEnd > 0) {
        const remaining = floodEnd - Date.now()
        if (remaining > 0) {
          if (task.taskType !== "content") {
            // Status is ephemeral — drop
            continue
          }
          await Bun.sleep(remaining)
        }
        _floodUntil.delete(userId)
      }

      if (task.taskType === "content") {
        const merged = _mergeContentTasks(task, queue, userId)
        await _processContentTask(bot, userId, merged)
      }
      else if (task.taskType === "status_update") {
        await _processStatusUpdateTask(bot, userId, task)
      }
      else if (task.taskType === "status_clear") {
        await _doDeleteStatusMessage(bot, userId, task.threadId ?? 0)
      }
    }
    catch (e: any) {
      if (isRetryAfter(e)) {
        const retrySecs = getRetryAfter(e)
        if (retrySecs > FLOOD_CONTROL_MAX_WAIT) {
          _floodUntil.set(userId, Date.now() + retrySecs * 1000)
        }
        else {
          await Bun.sleep(retrySecs * 1000)
        }
        // Re-queue the task
        const q = _queues.get(userId)
        if (q) q.unshift(task)
      }
      else {
        console.error(`Queue worker error for user ${userId}:`, e)
      }
    }
  }
}

function _mergeContentTasks(first: MessageTask, queue: MessageTask[], userId: number): MessageTask {
  if (first.contentType === "tool_use" || first.contentType === "tool_result") {
    return first
  }

  const merged = [...first.parts]
  let totalLen = merged.reduce((a, b) => a + b.length, 0)
  let i = 0

  while (i < queue.length) {
    const candidate = queue[i]!
    if (candidate.taskType !== "content") break
    if (candidate.windowId !== first.windowId) break
    if (candidate.contentType === "tool_use" || candidate.contentType === "tool_result") break

    const candidateLen = candidate.parts.reduce((a, b) => a + b.length, 0)
    if (totalLen + candidateLen > MERGE_MAX_LENGTH) break

    merged.push(...candidate.parts)
    totalLen += candidateLen
    queue.splice(i, 1)
    // Don't increment i — next element shifted into position
  }

  if (merged.length === first.parts.length) return first

  return {
    taskType: "content",
    text: first.text,
    windowId: first.windowId,
    parts: merged,
    toolUseId: first.toolUseId,
    contentType: first.contentType,
    threadId: first.threadId,
  }
}

async function _processContentTask(bot: Bot, userId: number, task: MessageTask): Promise<void> {
  const wid = task.windowId ?? ""
  const tid = task.threadId ?? 0
  const chatId = sessionManager.resolveChatId(userId, task.threadId)

  // Handle tool_result editing
  if (task.contentType === "tool_result" && task.toolUseId) {
    const tkey = toolKey(task.toolUseId, userId, tid)
    const editMsgId = _toolMsgIds.get(tkey)
    if (editMsgId != null) {
      _toolMsgIds.delete(tkey)
      await _doDeleteStatusMessage(bot, userId, tid)
      const fullText = task.parts.join("\n\n")
      try {
        await bot.api.editMessageText(chatId, editMsgId, convertMarkdown(fullText), {
          parse_mode: "MarkdownV2",
          link_preview_options: NO_LINK_PREVIEW,
        })
        if (task.imageData?.length) {
          await sendPhoto(bot, chatId, task.imageData, threadKwargs(task.threadId))
        }
        await _checkAndSendStatus(bot, userId, wid, task.threadId)
        return
      }
      catch (e: any) {
        if (isRetryAfter(e)) throw e
        try {
          const plain = stripSentinels(task.text ?? fullText)
          await bot.api.editMessageText(chatId, editMsgId, plain, {
            link_preview_options: NO_LINK_PREVIEW,
          })
          if (task.imageData?.length) {
            await sendPhoto(bot, chatId, task.imageData, threadKwargs(task.threadId))
          }
          await _checkAndSendStatus(bot, userId, wid, task.threadId)
          return
        }
        catch (e2: any) {
          if (isRetryAfter(e2)) throw e2
          // Fall through to send as new message
        }
      }
    }
  }

  // Send content messages
  let firstPart = true
  let lastMsgId: number | null = null

  for (const part of task.parts) {
    if (firstPart) {
      firstPart = false
      const converted = await _convertStatusToContent(bot, userId, tid, wid, part)
      if (converted != null) {
        lastMsgId = converted
        continue
      }
    }

    const sent = await sendWithFallback(bot, chatId, part, threadKwargs(task.threadId))
    if (sent) lastMsgId = sent.message_id
  }

  // Record tool_use message ID for later editing
  if (lastMsgId != null && task.toolUseId && task.contentType === "tool_use") {
    _toolMsgIds.set(toolKey(task.toolUseId, userId, tid), lastMsgId)
  }

  // Send images
  if (task.imageData?.length) {
    await sendPhoto(bot, chatId, task.imageData, threadKwargs(task.threadId))
  }

  // After content, check and send status
  await _checkAndSendStatus(bot, userId, wid, task.threadId)
}

async function _convertStatusToContent(
  bot: Bot,
  userId: number,
  threadIdOrZero: number,
  windowId: string,
  contentText: string,
): Promise<number | null> {
  const skey = statusKey(userId, threadIdOrZero)
  const info = _statusMsgInfo.get(skey)
  if (!info) return null

  _statusMsgInfo.delete(skey)
  const [msgId, storedWid] = info
  const chatId = sessionManager.resolveChatId(userId, threadIdOrZero || undefined)

  if (storedWid !== windowId) {
    try { await bot.api.deleteMessage(chatId, msgId) } catch {}
    return null
  }

  try {
    await bot.api.editMessageText(chatId, msgId, convertMarkdown(contentText), {
      parse_mode: "MarkdownV2",
      link_preview_options: NO_LINK_PREVIEW,
    })
    return msgId
  }
  catch (e: any) {
    if (isRetryAfter(e)) throw e
    try {
      await bot.api.editMessageText(chatId, msgId, stripSentinels(contentText), {
        link_preview_options: NO_LINK_PREVIEW,
      })
      return msgId
    }
    catch (e2: any) {
      if (isRetryAfter(e2)) throw e2
      return null
    }
  }
}

async function _processStatusUpdateTask(bot: Bot, userId: number, task: MessageTask): Promise<void> {
  const wid = task.windowId ?? ""
  const tid = task.threadId ?? 0
  const chatId = sessionManager.resolveChatId(userId, task.threadId)
  const skey = statusKey(userId, tid)
  const statusText = task.text ?? ""

  if (!statusText) {
    await _doDeleteStatusMessage(bot, userId, tid)
    return
  }

  const current = _statusMsgInfo.get(skey)

  if (current) {
    const [msgId, storedWid, lastText] = current

    if (storedWid !== wid) {
      await _doDeleteStatusMessage(bot, userId, tid)
      await _doSendStatusMessage(bot, userId, tid, wid, statusText)
    }
    else if (statusText === lastText) {
      // unchanged
    }
    else {
      if (statusText.toLowerCase().includes("esc to interrupt")) {
        try { await bot.api.sendChatAction(chatId, "typing") } catch {}
      }
      try {
        await bot.api.editMessageText(chatId, msgId, convertMarkdown(statusText), {
          parse_mode: "MarkdownV2",
          link_preview_options: NO_LINK_PREVIEW,
        })
        _statusMsgInfo.set(skey, [msgId, wid, statusText])
      }
      catch (e: any) {
        if (isRetryAfter(e)) throw e
        try {
          await bot.api.editMessageText(chatId, msgId, statusText, {
            link_preview_options: NO_LINK_PREVIEW,
          })
          _statusMsgInfo.set(skey, [msgId, wid, statusText])
        }
        catch (e2: any) {
          if (isRetryAfter(e2)) throw e2
          _statusMsgInfo.delete(skey)
          await _doSendStatusMessage(bot, userId, tid, wid, statusText)
        }
      }
    }
  }
  else {
    await _doSendStatusMessage(bot, userId, tid, wid, statusText)
  }
}

async function _doSendStatusMessage(
  bot: Bot,
  userId: number,
  threadIdOrZero: number,
  windowId: string,
  text: string,
): Promise<void> {
  const skey = statusKey(userId, threadIdOrZero)
  const threadId = threadIdOrZero || undefined
  const chatId = sessionManager.resolveChatId(userId, threadId ?? null)

  // Delete any orphaned status message
  const old = _statusMsgInfo.get(skey)
  if (old) {
    _statusMsgInfo.delete(skey)
    try { await bot.api.deleteMessage(chatId, old[0]) } catch {}
  }

  if (text.toLowerCase().includes("esc to interrupt")) {
    try { await bot.api.sendChatAction(chatId, "typing") } catch {}
  }

  const sent = await sendWithFallback(bot, chatId, text, threadId ? { message_thread_id: threadId } : {})
  if (sent) {
    _statusMsgInfo.set(skey, [sent.message_id, windowId, text])
  }
}

async function _doDeleteStatusMessage(bot: Bot, userId: number, threadIdOrZero: number): Promise<void> {
  const skey = statusKey(userId, threadIdOrZero)
  const info = _statusMsgInfo.get(skey)
  if (!info) return
  _statusMsgInfo.delete(skey)
  const chatId = sessionManager.resolveChatId(userId, threadIdOrZero || undefined)
  try { await bot.api.deleteMessage(chatId, info[0]) } catch {}
}

async function _checkAndSendStatus(
  bot: Bot,
  userId: number,
  windowId: string,
  threadId: number | undefined,
): Promise<void> {
  const queue = _queues.get(userId)
  if (queue && queue.length > 0) return

  const w = await tmuxManager.findWindowById(windowId)
  if (!w) return

  const paneText = await tmuxManager.capturPane(w.windowId)
  if (!paneText) return

  const tid = threadId ?? 0
  const statusLine = parseStatusLine(paneText)
  if (statusLine) {
    await _doSendStatusMessage(bot, userId, tid, windowId, statusLine)
  }
}

// --- Public API ---

export async function enqueueContentMessage(
  bot: Bot,
  userId: number,
  windowId: string,
  parts: string[],
  opts: {
    toolUseId?: string
    contentType?: string
    text?: string
    threadId?: number
    imageData?: Array<[string, Uint8Array]>
  } = {},
): Promise<void> {
  const task: MessageTask = {
    taskType: "content",
    text: opts.text,
    windowId,
    parts,
    toolUseId: opts.toolUseId,
    contentType: opts.contentType ?? "text",
    threadId: opts.threadId,
    imageData: opts.imageData,
  }
  getOrCreateQueue(bot, userId)
  _queues.get(userId)!.push(task)
  // Trigger worker if not already running
  if (!_workers.get(userId)) {
    _workers.set(userId, true)
    _runWorker(bot, userId).catch(e => console.error("Worker error:", e))
  }
}

export async function enqueueStatusUpdate(
  bot: Bot,
  userId: number,
  windowId: string,
  statusText: string | null,
  opts: { threadId?: number } = {},
): Promise<void> {
  // Don't enqueue during flood control
  const floodEnd = _floodUntil.get(userId) ?? 0
  if (floodEnd > Date.now()) return

  const tid = opts.threadId ?? 0

  // Deduplicate
  if (statusText) {
    const skey = statusKey(userId, tid)
    const info = _statusMsgInfo.get(skey)
    if (info && info[1] === windowId && info[2] === statusText) return
  }

  const task: MessageTask = statusText
    ? {
        taskType: "status_update",
        text: statusText,
        windowId,
        parts: [],
        contentType: "text",
        threadId: opts.threadId,
      }
    : {
        taskType: "status_clear",
        parts: [],
        contentType: "text",
        threadId: opts.threadId,
      }

  getOrCreateQueue(bot, userId)
  _queues.get(userId)!.push(task)
  if (!_workers.get(userId)) {
    _workers.set(userId, true)
    _runWorker(bot, userId).catch(e => console.error("Worker error:", e))
  }
}

export function clearStatusMsgInfo(userId: number, threadId?: number | null): void {
  const skey = statusKey(userId, threadId ?? 0)
  _statusMsgInfo.delete(skey)
}

export function clearToolMsgIdsForTopic(userId: number, threadId?: number | null): void {
  const tid = threadId ?? 0
  for (const key of [..._toolMsgIds.keys()]) {
    const parts = key.split(":")
    if (parts[1] === String(userId) && parts[2] === String(tid)) {
      _toolMsgIds.delete(key)
    }
  }
}

export async function shutdownWorkers(): Promise<void> {
  for (const userId of _workers.keys()) {
    _workers.delete(userId)
  }
  _queues.clear()
}
