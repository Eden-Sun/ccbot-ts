/**
 * Markdown → Telegram MarkdownV2 conversion layer.
 *
 * Handles expandable blockquotes (sentinel tokens from TranscriptParser)
 * separately from regular markdown. Expandable quotes are formatted as
 * the Telegram >…|| expandable blockquote syntax.
 *
 * Key export: convertMarkdown(text) → MarkdownV2 string
 */

import { TranscriptParser } from "./transcript"

const EXPSTART = TranscriptParser.EXPANDABLE_QUOTE_START
const EXPEND = TranscriptParser.EXPANDABLE_QUOTE_END

function escReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const EXPQUOTE_RE = new RegExp(
  escReg(EXPSTART) + "([\\s\\S]*?)" + escReg(EXPEND),
  "g",
)

/** Escape all MarkdownV2 special characters in plain text */
export function mdv2Escape(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!\-\\]/g, "\\$&")
}

/** Escape characters special inside code/pre blocks */
function codeEscape(text: string): string {
  return text.replace(/[\\`]/g, "\\$&")
}

/** Escape characters special inside URLs */
function urlEscape(url: string): string {
  return url.replace(/[\\)]/g, "\\$&")
}

/** Strip expandable quote sentinels (for plain text fallback) */
export function stripSentinels(text: string): string {
  return text
    .replace(new RegExp(escReg(EXPSTART), "g"), "")
    .replace(new RegExp(escReg(EXPEND), "g"), "")
}

const EXPQUOTE_MAX_RENDERED = 3800

function renderExpandableQuote(inner: string): string {
  const escaped = mdv2Escape(inner)
  const lines = escaped.split("\n")
  const suffix = "\n>\\.\\.\\.  \\(truncated\\)||"
  const budget = EXPQUOTE_MAX_RENDERED - suffix.length

  const built: string[] = []
  let total = 0
  let truncated = false

  for (const line of lines) {
    const cost = 1 + line.length + 1
    if (total + cost > budget) {
      const rem = budget - total - 2
      if (rem > 20) built.push(">" + line.slice(0, rem))
      truncated = true
      break
    }
    built.push(">" + line)
    total += cost
  }

  return truncated ? built.join("\n") + suffix : built.join("\n") + "||"
}

/** Convert standard Markdown to Telegram MarkdownV2 */
export function convertMarkdown(text: string): string {
  if (!text) return ""

  // Split by expandable quote blocks
  const parts: string[] = []
  let lastEnd = 0

  for (const m of text.matchAll(EXPQUOTE_RE)) {
    const start = m.index
    if (start > lastEnd) {
      parts.push(convertPlainMarkdown(text.slice(lastEnd, start)))
    }
    parts.push(renderExpandableQuote(m[1]))
    lastEnd = start + m[0].length
  }
  if (lastEnd < text.length) {
    parts.push(convertPlainMarkdown(text.slice(lastEnd)))
  }

  return parts.length > 0 ? parts.join("") : convertPlainMarkdown(text)
}

/**
 * Convert a markdown segment (no expandable quote sentinels) to MarkdownV2.
 * Uses span-based approach: identify protected regions, escape the gaps.
 */
function convertPlainMarkdown(text: string): string {
  if (!text) return ""

  interface Span { start: number; end: number; rendered: string }
  const spans: Span[] = []

  const addSpan = (start: number, end: number, rendered: string): void => {
    // Check for overlap
    if (spans.some(s => start < s.end && end > s.start)) return
    spans.push({ start, end, rendered })
  }

  // 1. Fenced code blocks (highest priority)
  for (const m of text.matchAll(/```(\w*)\n?([\s\S]*?)```/g)) {
    const lang = m[1] ?? ""
    const code = (m[2] ?? "").replace(/^\n/, "").replace(/\n$/, "")
    addSpan(m.index, m.index + m[0].length,
      "```" + lang + "\n" + codeEscape(code) + "\n```")
  }

  // 2. Inline code
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    addSpan(m.index, m.index + m[0].length, "`" + codeEscape(m[1]) + "`")
  }

  // 3. Links [text](url)
  for (const m of text.matchAll(/\[([^\]]*)\]\(([^)]*)\)/g)) {
    addSpan(m.index, m.index + m[0].length,
      "[" + mdv2Escape(m[1]) + "](" + urlEscape(m[2]) + ")")
  }

  // 4. Bold **text**
  for (const m of text.matchAll(/\*\*([^*\n]+)\*\*/g)) {
    addSpan(m.index, m.index + m[0].length, "*" + mdv2Escape(m[1]) + "*")
  }

  // 5. Bold __text__
  for (const m of text.matchAll(/__([^_\n]+)__/g)) {
    addSpan(m.index, m.index + m[0].length, "*" + mdv2Escape(m[1]) + "*")
  }

  // 6. Italic *text* (not **)
  for (const m of text.matchAll(/(?<!\*)\*([^*\n]+)\*(?!\*)/g)) {
    addSpan(m.index, m.index + m[0].length, "_" + mdv2Escape(m[1]) + "_")
  }

  // 7. Italic _text_
  for (const m of text.matchAll(/(?<!_)_([^_\n]+)_(?!_)/g)) {
    addSpan(m.index, m.index + m[0].length, "_" + mdv2Escape(m[1]) + "_")
  }

  // 8. Strikethrough ~~text~~
  for (const m of text.matchAll(/~~([^~\n]+)~~/g)) {
    addSpan(m.index, m.index + m[0].length, "~" + mdv2Escape(m[1]) + "~")
  }

  // 9. Headers at line start
  for (const m of text.matchAll(/^#{1,6} (.+)$/gm)) {
    addSpan(m.index, m.index + m[0].length, "*" + mdv2Escape(m[1].trim()) + "*")
  }

  // Sort by start position
  spans.sort((a, b) => a.start - b.start)

  // Build result: escape gaps, use rendered for spans
  const result: string[] = []
  let pos = 0

  for (const span of spans) {
    if (span.start > pos) {
      result.push(mdv2Escape(text.slice(pos, span.start)))
    }
    result.push(span.rendered)
    pos = span.end
  }

  if (pos < text.length) {
    result.push(mdv2Escape(text.slice(pos)))
  }

  return result.join("")
}
