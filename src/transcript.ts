/**
 * JSONL transcript parser for Claude Code session files.
 *
 * Parses Claude Code session JSONL files and extracts structured messages.
 * Handles: text, thinking, tool_use, tool_result, local_command, and user messages.
 * Tool pairing: tool_use blocks in assistant messages are matched with
 * tool_result blocks in subsequent user messages via tool_use_id.
 *
 * Shared by both session (history) and session_monitor (real-time).
 * Format reference: https://github.com/desis123/claude-code-viewer
 */

import type { ParsedEntry, ParsedMessage, PendingToolInfo } from "./types"

// ---------------------------------------------------------------------------
// Simple unified diff (replaces Python difflib.unified_diff)
// ---------------------------------------------------------------------------

function formatEditDiff(oldString: string, newString: string): string {
  const oldLines = oldString.split("\n")
  const newLines = newString.split("\n")

  // Myers-like LCS to produce unified diff hunks
  const lcs = computeLCS(oldLines, newLines)
  const hunks = buildUnifiedHunks(oldLines, newLines, lcs)
  return hunks.join("\n")
}

/** Compute LCS table and return match flags for old/new lines. */
function computeLCS(
  oldLines: string[],
  newLines: string[],
): { oldMatch: boolean[]; newMatch: boolean[] } {
  const m = oldLines.length
  const n = newLines.length
  // DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i]![j] = dp[i + 1]![j + 1]! + 1
      }
      else {
        dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
      }
    }
  }

  const oldMatch = new Array<boolean>(m).fill(false)
  const newMatch = new Array<boolean>(n).fill(false)
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      oldMatch[i] = true
      newMatch[j] = true
      i++
      j++
    }
    else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      i++
    }
    else {
      j++
    }
  }
  return { oldMatch, newMatch }
}

/** Build unified diff output lines from match flags. */
function buildUnifiedHunks(
  oldLines: string[],
  newLines: string[],
  lcs: { oldMatch: boolean[]; newMatch: boolean[] },
): string[] {
  const result: string[] = []
  const { oldMatch, newMatch } = lcs
  let oi = 0
  let ni = 0

  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && oldMatch[oi] && ni < newLines.length && newMatch[ni]) {
      // Context line — skip (we only emit changed lines like Python's unified_diff header-stripped output)
      oi++
      ni++
      continue
    }

    // Collect a hunk of changes
    const hunkStart = result.length
    // Emit @@ header placeholder
    const hunkOldStart = oi + 1
    const hunkNewStart = ni + 1
    let hunkOldCount = 0
    let hunkNewCount = 0
    let contextBefore = 0

    // Add up to 3 context lines before
    const ctxStart = Math.max(0, oi - 3)
    // But we need to track context for the header, skip actual emission for brevity
    // Just collect removed/added lines

    // Removed lines
    while (oi < oldLines.length && !oldMatch[oi]) {
      result.push(`-${oldLines[oi]}`)
      hunkOldCount++
      oi++
    }
    // Added lines
    while (ni < newLines.length && !newMatch[ni]) {
      result.push(`+${newLines[ni]}`)
      hunkNewCount++
      ni++
    }

    // Insert @@ header before this hunk's lines
    if (hunkOldCount > 0 || hunkNewCount > 0) {
      const header = `@@ -${hunkOldStart},${hunkOldCount} +${hunkNewStart},${hunkNewCount} @@`
      result.splice(hunkStart, 0, header)
    }

    // Advance past matching lines
    if (oi < oldLines.length && ni < newLines.length && oldMatch[oi] && newMatch[ni]) {
      oi++
      ni++
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// TranscriptParser
// ---------------------------------------------------------------------------

const RE_ANSI_ESCAPE = /\x1b\[[0-9;]*m/g
const RE_COMMAND_NAME = /<command-name>(.*?)<\/command-name>/
const RE_LOCAL_STDOUT = /<local-command-stdout>(.*?)<\/local-command-stdout>/s
const RE_SYSTEM_TAGS = /<(bash-input|bash-stdout|bash-stderr|local-command-caveat|system-reminder)/

const NO_CONTENT_PLACEHOLDER = "(no content)"
const INTERRUPTED_TEXT = "[Request interrupted by user for tool use]"
const MAX_SUMMARY_LENGTH = 200

export class TranscriptParser {
  static EXPANDABLE_QUOTE_START = "\x02EXPQUOTE_START\x02"
  static EXPANDABLE_QUOTE_END = "\x02EXPQUOTE_END\x02"

  // ----- low-level helpers -----

  static parseLine(line: string): Record<string, any> | null {
    line = line.trim()
    if (!line) return null
    try {
      return JSON.parse(line)
    }
    catch {
      return null
    }
  }

  static getMessageType(data: Record<string, any>): string | null {
    return (data.type as string) ?? null
  }

  static isUserMessage(data: Record<string, any>): boolean {
    return data.type === "user"
  }

  static extractTextOnly(contentList: any[]): string {
    if (!Array.isArray(contentList)) {
      if (typeof contentList === "string") return contentList
      return ""
    }
    const texts: string[] = []
    for (const item of contentList) {
      if (typeof item === "string") {
        texts.push(item)
      }
      else if (typeof item === "object" && item !== null) {
        if (item.type === "text") {
          const text = item.text ?? ""
          if (text) texts.push(text)
        }
      }
    }
    return texts.join("\n")
  }

  static formatToolUseSummary(name: string, inputData: any): string {
    if (typeof inputData !== "object" || inputData === null || Array.isArray(inputData)) {
      return `**${name}**`
    }

    let summary = ""

    if (name === "Read" || name === "Glob") {
      summary = inputData.file_path ?? inputData.pattern ?? ""
    }
    else if (name === "Write") {
      summary = inputData.file_path ?? ""
    }
    else if (name === "Edit" || name === "NotebookEdit") {
      summary = inputData.file_path ?? inputData.notebook_path ?? ""
    }
    else if (name === "Bash") {
      summary = inputData.command ?? ""
    }
    else if (name === "Grep") {
      summary = inputData.pattern ?? ""
    }
    else if (name === "Task") {
      summary = inputData.description ?? ""
    }
    else if (name === "WebFetch") {
      summary = inputData.url ?? ""
    }
    else if (name === "WebSearch") {
      summary = inputData.query ?? ""
    }
    else if (name === "TodoWrite") {
      const todos = inputData.todos
      if (Array.isArray(todos)) {
        summary = `${todos.length} item(s)`
      }
    }
    else if (name === "TodoRead") {
      summary = ""
    }
    else if (name === "AskUserQuestion") {
      const questions = inputData.questions
      if (Array.isArray(questions) && questions.length > 0) {
        const q = questions[0]
        if (typeof q === "object" && q !== null) {
          summary = q.question ?? ""
        }
      }
    }
    else if (name === "ExitPlanMode") {
      summary = ""
    }
    else if (name === "Skill") {
      summary = inputData.skill ?? ""
    }
    else {
      // Generic: first string value
      for (const v of Object.values(inputData)) {
        if (typeof v === "string" && v) {
          summary = v
          break
        }
      }
    }

    if (summary) {
      if (summary.length > MAX_SUMMARY_LENGTH) {
        summary = `${summary.slice(0, MAX_SUMMARY_LENGTH)}\u2026`
      }
      return `**${name}**(${summary})`
    }
    return `**${name}**`
  }

  static extractToolResultText(content: any): string {
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      const parts: string[] = []
      for (const item of content) {
        if (typeof item === "object" && item !== null && item.type === "text") {
          const t = item.text ?? ""
          if (t) parts.push(t)
        }
        else if (typeof item === "string") {
          parts.push(item)
        }
      }
      return parts.join("\n")
    }
    return ""
  }

  static extractToolResultImages(content: any): Array<[string, Uint8Array]> | null {
    if (!Array.isArray(content)) return null
    const images: Array<[string, Uint8Array]> = []
    for (const item of content) {
      if (typeof item !== "object" || item === null || item.type !== "image") continue
      const source = item.source
      if (typeof source !== "object" || source === null || source.type !== "base64") continue
      const mediaType: string = source.media_type ?? "image/png"
      const dataStr: string = source.data ?? ""
      if (!dataStr) continue
      try {
        const buf = Buffer.from(dataStr, "base64")
        images.push([mediaType, new Uint8Array(buf)])
      }
      catch {
        // Failed to decode base64 image
      }
    }
    return images.length > 0 ? images : null
  }

  static parseMessage(data: Record<string, any>): ParsedMessage | null {
    const msgType = this.getMessageType(data)
    if (msgType !== "user" && msgType !== "assistant") return null

    const message = data.message
    if (typeof message !== "object" || message === null) return null

    let content = message.content ?? ""
    let text: string

    if (Array.isArray(content)) {
      text = this.extractTextOnly(content)
    }
    else {
      text = content ? String(content) : ""
    }
    text = text.replace(RE_ANSI_ESCAPE, "")

    // Detect local command responses in user messages
    if (msgType === "user" && text) {
      const stdoutMatch = RE_LOCAL_STDOUT.exec(text)
      if (stdoutMatch) {
        const stdout = (stdoutMatch[1] ?? "").trim()
        const cmdMatch = RE_COMMAND_NAME.exec(text)
        const cmd = cmdMatch ? cmdMatch[1] : undefined
        return { messageType: "local_command", text: stdout, toolName: cmd }
      }
      // Pure command invocation (no stdout)
      const cmdMatch = RE_COMMAND_NAME.exec(text)
      if (cmdMatch) {
        return { messageType: "local_command_invoke", text: "", toolName: cmdMatch[1] }
      }
    }

    return { messageType: msgType, text }
  }

  static getTimestamp(data: Record<string, any>): string | null {
    return (data.timestamp as string) ?? null
  }

  // ----- internal formatting helpers -----

  private static _formatExpandableQuote(text: string): string {
    return `${this.EXPANDABLE_QUOTE_START}${text}${this.EXPANDABLE_QUOTE_END}`
  }

  private static _formatToolResultText(text: string, toolName?: string | null): string {
    if (!text) return ""

    const lineCount = text ? text.split("\n").length : 0

    if (toolName === "Read") {
      return `  \u23BF  Read ${lineCount} lines`
    }

    if (toolName === "Write") {
      return `  \u23BF  Wrote ${lineCount} lines`
    }

    if (toolName === "Bash") {
      if (lineCount > 0) {
        const stats = `  \u23BF  Output ${lineCount} lines`
        return `${stats}\n${this._formatExpandableQuote(text)}`
      }
      return this._formatExpandableQuote(text)
    }

    if (toolName === "Grep") {
      const matches = text.split("\n").filter(l => l.trim()).length
      const stats = `  \u23BF  Found ${matches} matches`
      return `${stats}\n${this._formatExpandableQuote(text)}`
    }

    if (toolName === "Glob") {
      const files = text.split("\n").filter(l => l.trim()).length
      const stats = `  \u23BF  Found ${files} files`
      return `${stats}\n${this._formatExpandableQuote(text)}`
    }

    if (toolName === "Task") {
      if (lineCount > 0) {
        const stats = `  \u23BF  Agent output ${lineCount} lines`
        return `${stats}\n${this._formatExpandableQuote(text)}`
      }
      return this._formatExpandableQuote(text)
    }

    if (toolName === "WebFetch") {
      const charCount = text.length
      const stats = `  \u23BF  Fetched ${charCount} characters`
      return `${stats}\n${this._formatExpandableQuote(text)}`
    }

    if (toolName === "WebSearch") {
      const results = text ? (text.match(/\n\n/g) ?? []).length + 1 : 0
      const stats = `  \u23BF  ${results} search results`
      return `${stats}\n${this._formatExpandableQuote(text)}`
    }

    // Default: expandable quote without stats
    return this._formatExpandableQuote(text)
  }

  // ----- core entry parser -----

  static parseEntries(
    entries: Record<string, any>[],
    pendingTools?: Map<string, PendingToolInfo>,
  ): [ParsedEntry[], Map<string, PendingToolInfo>] {
    const result: ParsedEntry[] = []
    let lastCmdName: string | null = null

    const carryOver = pendingTools !== undefined
    // Work on a copy so we don't mutate caller's map
    const pending = new Map<string, PendingToolInfo>(pendingTools ?? [])

    for (const data of entries) {
      const msgType = this.getMessageType(data)
      if (msgType !== "user" && msgType !== "assistant") continue

      const entryTimestamp = this.getTimestamp(data) ?? undefined

      const message = data.message
      if (typeof message !== "object" || message === null) continue

      let content: any[] = message.content ?? ""
      if (!Array.isArray(content)) {
        content = content ? [{ type: "text", text: String(content) }] : []
      }

      const parsed = this.parseMessage(data)

      // Handle local command messages first
      if (parsed) {
        if (parsed.messageType === "local_command_invoke") {
          lastCmdName = parsed.toolName ?? null
          continue
        }
        if (parsed.messageType === "local_command") {
          const cmd = parsed.toolName ?? lastCmdName ?? ""
          const text = parsed.text
          let formatted: string
          if (cmd) {
            formatted = text.includes("\n")
              ? `\u276F \`${cmd}\`\n\`\`\`\n${text}\n\`\`\``
              : `\u276F \`${cmd}\`\n\`${text}\``
          }
          else {
            formatted = text.includes("\n")
              ? `\`\`\`\n${text}\n\`\`\``
              : `\`${text}\``
          }
          result.push({
            role: "assistant",
            text: formatted,
            contentType: "local_command",
            timestamp: entryTimestamp,
          })
          lastCmdName = null
          continue
        }
      }
      lastCmdName = null

      if (msgType === "assistant") {
        let hasText = false
        for (const block of content) {
          if (typeof block !== "object" || block === null) continue
          const btype: string = block.type ?? ""

          if (btype === "text") {
            const t = (block.text ?? "").trim()
            if (t && t !== NO_CONTENT_PLACEHOLDER) {
              result.push({
                role: "assistant",
                text: t,
                contentType: "text",
                timestamp: entryTimestamp,
              })
              hasText = true
            }
          }
          else if (btype === "tool_use") {
            const toolId: string = block.id ?? ""
            const name: string = block.name ?? "unknown"
            const inp = block.input ?? {}
            const summary = this.formatToolUseSummary(name, inp)

            // ExitPlanMode: emit plan content as text before tool_use entry
            if (name === "ExitPlanMode" && typeof inp === "object" && inp !== null) {
              const plan = inp.plan ?? ""
              if (plan) {
                result.push({
                  role: "assistant",
                  text: plan,
                  contentType: "text",
                  timestamp: entryTimestamp,
                })
              }
            }

            if (toolId) {
              const inputData = (name === "Edit" || name === "NotebookEdit") ? inp : undefined
              pending.set(toolId, { summary, toolName: name, inputData })
              result.push({
                role: "assistant",
                text: summary,
                contentType: "tool_use",
                toolUseId: toolId,
                timestamp: entryTimestamp,
                toolName: name,
              })
            }
            else {
              result.push({
                role: "assistant",
                text: summary,
                contentType: "tool_use",
                toolUseId: toolId || undefined,
                timestamp: entryTimestamp,
                toolName: name,
              })
            }
          }
          else if (btype === "thinking") {
            const thinkingText: string = block.thinking ?? ""
            if (thinkingText) {
              const quoted = this._formatExpandableQuote(thinkingText)
              result.push({
                role: "assistant",
                text: quoted,
                contentType: "thinking",
                timestamp: entryTimestamp,
              })
            }
            else if (!hasText) {
              result.push({
                role: "assistant",
                text: "(thinking)",
                contentType: "thinking",
                timestamp: entryTimestamp,
              })
            }
          }
        }
      }
      else if (msgType === "user") {
        const userTextParts: string[] = []

        for (const block of content) {
          if (typeof block !== "object" || block === null) {
            if (typeof block === "string" && block.trim()) {
              userTextParts.push(block.trim())
            }
            continue
          }
          const btype: string = block.type ?? ""

          if (btype === "tool_result") {
            const toolUseId: string = block.tool_use_id ?? ""
            const resultContent = block.content ?? ""
            const resultText = this.extractToolResultText(resultContent)
            const resultImages = this.extractToolResultImages(resultContent)
            const isError: boolean = block.is_error ?? false
            const isInterrupted = resultText === INTERRUPTED_TEXT
            const toolInfo = pending.get(toolUseId)
            if (toolInfo) pending.delete(toolUseId)
            const tuid = toolUseId || undefined

            const toolSummary = toolInfo?.summary ?? null
            const toolName = toolInfo?.toolName ?? null
            const toolInputData = toolInfo?.inputData ?? null

            if (isInterrupted) {
              let entryText = toolSummary ?? ""
              entryText = entryText ? `${entryText}\n\u23F9 Interrupted` : "\u23F9 Interrupted"
              result.push({
                role: "assistant",
                text: entryText,
                contentType: "tool_result",
                toolUseId: tuid,
                timestamp: entryTimestamp,
              })
            }
            else if (isError) {
              let entryText = toolSummary ?? "**Error**"
              if (resultText) {
                let errorSummary = resultText.split("\n")[0] ?? ""
                if (errorSummary.length > 100) {
                  errorSummary = `${errorSummary.slice(0, 100)}\u2026`
                }
                entryText += `\n  \u23BF  Error: ${errorSummary}`
                if (resultText.includes("\n")) {
                  entryText += `\n${this._formatExpandableQuote(resultText)}`
                }
              }
              else {
                entryText += "\n  \u23BF  Error"
              }
              result.push({
                role: "assistant",
                text: entryText,
                contentType: "tool_result",
                toolUseId: tuid,
                timestamp: entryTimestamp,
                imageData: resultImages ?? undefined,
              })
            }
            else if (toolSummary) {
              let entryText = toolSummary
              // Edit tool: generate diff
              if (toolName === "Edit" && toolInputData && resultText) {
                const oldS: string = toolInputData.old_string ?? ""
                const newS: string = toolInputData.new_string ?? ""
                if (oldS && newS) {
                  const diffText = formatEditDiff(oldS, newS)
                  if (diffText) {
                    const added = diffText.split("\n").filter(
                      l => l.startsWith("+") && !l.startsWith("+++"),
                    ).length
                    const removed = diffText.split("\n").filter(
                      l => l.startsWith("-") && !l.startsWith("---"),
                    ).length
                    const stats = `  \u23BF  Added ${added} lines, removed ${removed} lines`
                    entryText += `\n${stats}\n${this._formatExpandableQuote(diffText)}`
                  }
                }
              }
              else if (resultText && !toolSummary.includes(this.EXPANDABLE_QUOTE_START)) {
                entryText += `\n${this._formatToolResultText(resultText, toolName)}`
              }
              result.push({
                role: "assistant",
                text: entryText,
                contentType: "tool_result",
                toolUseId: tuid,
                timestamp: entryTimestamp,
                imageData: resultImages ?? undefined,
              })
            }
            else if (resultText || resultImages) {
              result.push({
                role: "assistant",
                text: resultText
                  ? this._formatToolResultText(resultText, toolName)
                  : (toolSummary ?? ""),
                contentType: "tool_result",
                toolUseId: tuid,
                timestamp: entryTimestamp,
                imageData: resultImages ?? undefined,
              })
            }
          }
          else if (btype === "text") {
            const t = (block.text ?? "").trim()
            if (t && !RE_SYSTEM_TAGS.test(t)) {
              userTextParts.push(t)
            }
          }
        }

        // Add user text if present
        if (userTextParts.length > 0) {
          const combined = userTextParts.join("\n")
          if (!RE_LOCAL_STDOUT.test(combined) && !RE_COMMAND_NAME.test(combined)) {
            result.push({
              role: "user",
              text: combined,
              contentType: "text",
              timestamp: entryTimestamp,
            })
          }
        }
      }
    }

    // Flush remaining pending tools
    const remainingPending = new Map(pending)
    if (!carryOver) {
      for (const [toolId, toolInfo] of pending) {
        result.push({
          role: "assistant",
          text: toolInfo.summary,
          contentType: "tool_use",
          toolUseId: toolId,
        })
      }
    }

    // Strip whitespace on all entries
    for (const entry of result) {
      entry.text = entry.text.trim()
    }

    return [result, remainingPending]
  }
}
