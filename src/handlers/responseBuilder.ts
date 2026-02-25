/**
 * Response message building for Telegram delivery.
 *
 * Builds paginated response messages from Claude Code output.
 * Markdown-to-MarkdownV2 conversion is done by the send layer.
 */

import { splitMessage } from "../utils"
import { TranscriptParser } from "../transcript"

export function buildResponseParts(
  text: string,
  isComplete: boolean,
  contentType = "text",
  role = "assistant",
): string[] {
  text = text.trim()

  // User messages: emoji prefix, truncate long ones
  if (role === "user") {
    if (text.length > 3000) text = text.slice(0, 3000) + "…"
    return [`👤 ${text}`]
  }

  // Truncate thinking content
  if (contentType === "thinking" && isComplete) {
    const startTag = TranscriptParser.EXPANDABLE_QUOTE_START
    const endTag = TranscriptParser.EXPANDABLE_QUOTE_END
    const maxThinking = 500

    if (text.includes(startTag) && text.includes(endTag)) {
      const innerStart = text.indexOf(startTag) + startTag.length
      const innerEnd = text.indexOf(endTag)
      let inner = text.slice(innerStart, innerEnd)
      if (inner.length > maxThinking) {
        inner = inner.slice(0, maxThinking) + "\n\n… (thinking truncated)"
      }
      text = startTag + inner + endTag
    }
    else if (text.length > maxThinking) {
      text = text.slice(0, maxThinking) + "\n\n… (thinking truncated)"
    }
  }

  // Format based on content type
  let prefix = ""
  let separator = ""
  if (contentType === "thinking") {
    prefix = "∴ Thinking…"
    separator = "\n"
  }

  // Expandable quotes must stay atomic (not split)
  if (text.includes(TranscriptParser.EXPANDABLE_QUOTE_START)) {
    return prefix ? [`${prefix}${separator}${text}`] : [text]
  }

  const maxText = 3000 - prefix.length - separator.length
  const chunks = splitMessage(text, maxText)
  const total = chunks.length

  if (total === 1) {
    return prefix ? [`${prefix}${separator}${chunks[0]}`] : [chunks[0]]
  }

  return chunks.map((chunk, i) => {
    const idx = i + 1
    return prefix
      ? `${prefix}${separator}${chunk}\n\n[${idx}/${total}]`
      : `${chunk}\n\n[${idx}/${total}]`
  })
}
