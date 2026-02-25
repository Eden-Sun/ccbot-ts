/**
 * Safe message sending helpers with MarkdownV2 fallback.
 *
 * All outbound Telegram API calls that need topic support MUST use the
 * bot.api methods with explicit chatId from sessionManager.resolveChatId().
 */

import type { Bot, RawApi } from "grammy"
import type { InlineKeyboardMarkup, LinkPreviewOptions, Message } from "@grammyjs/types"
import { convertMarkdown, stripSentinels } from "../markdown"

export const NO_LINK_PREVIEW: LinkPreviewOptions = { is_disabled: true }

/** Send a message with MarkdownV2, falling back to plain text on failure. */
export async function sendWithFallback(
  bot: Bot,
  chatId: number,
  text: string,
  opts: {
    message_thread_id?: number
    reply_markup?: InlineKeyboardMarkup
  } = {},
): Promise<Message | null> {
  const extra: Record<string, unknown> = {
    link_preview_options: NO_LINK_PREVIEW,
    ...opts,
  }
  try {
    return await bot.api.sendMessage(chatId, convertMarkdown(text), {
      parse_mode: "MarkdownV2",
      ...extra,
    }) as any
  }
  catch (e: any) {
    if (isRetryAfter(e)) throw e
    try {
      return await bot.api.sendMessage(chatId, stripSentinels(text), extra) as any
    }
    catch (e2: any) {
      if (isRetryAfter(e2)) throw e2
      console.error(`Failed to send message to ${chatId}:`, e2)
      return null
    }
  }
}

/** Send photo(s). Single photo or media group. */
export async function sendPhoto(
  bot: Bot,
  chatId: number,
  imageData: Array<[string, Uint8Array]>,
  opts: { message_thread_id?: number } = {},
): Promise<void> {
  if (!imageData.length) return
  try {
    if (imageData.length === 1) {
      const [, bytes] = imageData[0]
      await bot.api.sendPhoto(chatId, new Blob([bytes]), opts)
    }
    else {
      const media = imageData.map(([, bytes]) => ({
        type: "photo" as const,
        media: new Blob([bytes]),
      }))
      await bot.api.sendMediaGroup(chatId, media as any, opts)
    }
  }
  catch (e: any) {
    if (isRetryAfter(e)) throw e
    console.error(`Failed to send photo to ${chatId}:`, e)
  }
}

/** Reply to a message with MarkdownV2, fallback to plain text. */
export async function safeReply(
  bot: Bot,
  chatId: number,
  text: string,
  opts: {
    message_thread_id?: number
    reply_markup?: InlineKeyboardMarkup
    reply_to_message_id?: number
  } = {},
): Promise<Message | null> {
  const extra: Record<string, unknown> = {
    link_preview_options: NO_LINK_PREVIEW,
    ...opts,
  }
  try {
    return await bot.api.sendMessage(chatId, convertMarkdown(text), {
      parse_mode: "MarkdownV2",
      ...extra,
    }) as any
  }
  catch (e: any) {
    if (isRetryAfter(e)) throw e
    try {
      return await bot.api.sendMessage(chatId, stripSentinels(text), extra) as any
    }
    catch (e2: any) {
      if (isRetryAfter(e2)) throw e2
      console.error("Failed to reply:", e2)
      return null
    }
  }
}

/** Edit a message with MarkdownV2, fallback to plain text. */
export async function safeEdit(
  bot: Bot,
  chatId: number,
  messageId: number,
  text: string,
  opts: { reply_markup?: InlineKeyboardMarkup } = {},
): Promise<void> {
  const extra: Record<string, unknown> = {
    link_preview_options: NO_LINK_PREVIEW,
    ...opts,
  }
  try {
    await bot.api.editMessageText(chatId, messageId, convertMarkdown(text), {
      parse_mode: "MarkdownV2",
      ...extra,
    })
  }
  catch (e: any) {
    if (isRetryAfter(e)) throw e
    try {
      await bot.api.editMessageText(chatId, messageId, stripSentinels(text), extra)
    }
    catch (e2: any) {
      if (isRetryAfter(e2)) throw e2
      console.error("Failed to edit message:", e2)
    }
  }
}

/** Send a message with MarkdownV2, fallback to plain text. */
export async function safeSend(
  bot: Bot,
  chatId: number,
  text: string,
  opts: {
    message_thread_id?: number
    reply_markup?: InlineKeyboardMarkup
  } = {},
): Promise<void> {
  const extra: Record<string, unknown> = {
    link_preview_options: NO_LINK_PREVIEW,
    ...opts,
  }
  try {
    await bot.api.sendMessage(chatId, convertMarkdown(text), {
      parse_mode: "MarkdownV2",
      ...extra,
    })
  }
  catch (e: any) {
    if (isRetryAfter(e)) throw e
    try {
      await bot.api.sendMessage(chatId, stripSentinels(text), extra)
    }
    catch (e2: any) {
      if (isRetryAfter(e2)) throw e2
      console.error(`Failed to send message to ${chatId}:`, e2)
    }
  }
}

/** Check if an error is a Telegram rate-limit (429) error. */
export function isRetryAfter(e: unknown): boolean {
  if (e instanceof Error && "error_code" in (e as any)) {
    return (e as any).error_code === 429
  }
  return false
}

/** Extract retry_after seconds from a 429 error. */
export function getRetryAfter(e: unknown): number {
  if (e instanceof Error && "parameters" in (e as any)) {
    return (e as any).parameters?.retry_after ?? 30
  }
  return 30
}
