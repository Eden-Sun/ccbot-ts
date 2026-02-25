import type { InteractiveUIContent, UsageInfo } from "./types"

interface UIPattern {
  name: string
  top: RegExp[]
  bottom: RegExp[]
  minGap: number
}

const UI_PATTERNS: UIPattern[] = [
  {
    name: "ExitPlanMode",
    top: [/Do you want to exit plan mode/],
    bottom: [/Yes.*No/],
    minGap: 1,
  },
  {
    // AskUserQuestion multi-tab
    name: "AskUserQuestion",
    top: [/\s+\d+\.\s+/],
    bottom: [/\s+\d+\.\s+/],
    minGap: 0,
  },
  {
    // AskUserQuestion single-tab
    name: "AskUserQuestion",
    top: [/❯\s+/],
    bottom: [/\s{2,}/],
    minGap: 0,
  },
  {
    name: "PermissionPrompt",
    top: [/Allow|Deny|allow this|permission/i],
    bottom: [/Yes.*No|Allow.*Deny/],
    minGap: 1,
  },
  {
    name: "RestoreCheckpoint",
    top: [/restore.*checkpoint|checkpoint.*restore/i],
    bottom: [/Yes.*No/],
    minGap: 1,
  },
  {
    name: "Settings",
    top: [/Settings|settings/],
    bottom: [/Save.*Cancel|Done/],
    minGap: 1,
  },
]

const STATUS_SPINNERS = new Set(["·", "✻", "✽", "✶", "✳", "✢"])

/**
 * Find the chrome separator line index among the last N lines.
 * Chrome separator = line with 20+ consecutive ─ chars.
 * Returns absolute index in the lines array, or -1 if not found.
 */
function findChromeSeparator(lines: string[], searchLastN = 10): number {
  const start = Math.max(0, lines.length - searchLastN)
  for (let i = lines.length - 1; i >= start; i--) {
    if (/─{20,}/.test(lines[i])) {
      return i
    }
  }
  return -1
}

/**
 * Scan pane text for interactive UI patterns (top-down, first match wins).
 * Returns the content between the matched top and bottom boundaries.
 */
export function extractInteractiveContent(paneText: string): InteractiveUIContent | null {
  const lines = paneText.split("\n")

  // Strip chrome from the bottom so we only scan real content
  const strippedLines = stripPaneChrome(lines)
  if (strippedLines.length === 0) return null

  for (const pattern of UI_PATTERNS) {
    // Scan top-down for a top pattern match
    for (let topIdx = 0; topIdx < strippedLines.length; topIdx++) {
      const topMatch = pattern.top.some(re => re.test(strippedLines[topIdx]))
      if (!topMatch) continue

      // Now look for the bottom pattern after minGap lines
      const bottomStart = topIdx + pattern.minGap + 1
      for (let botIdx = bottomStart; botIdx < strippedLines.length; botIdx++) {
        const botMatch = pattern.bottom.some(re => re.test(strippedLines[botIdx]))
        if (!botMatch) continue

        // Found a match — extract content between top and bottom (inclusive)
        const content = strippedLines.slice(topIdx, botIdx + 1).join("\n")
        return { content, name: pattern.name }
      }
    }
  }
  return null
}

/**
 * Quick check: does the pane contain an interactive UI element?
 */
export function isInteractiveUI(paneText: string): boolean {
  return extractInteractiveContent(paneText) !== null
}

/**
 * Parse the status/spinner line from Claude Code's chrome area.
 * Looks for the chrome separator in the last 10 lines, then checks
 * the line directly above it for a spinner character.
 * Returns the status text (without spinner) or null.
 */
export function parseStatusLine(paneText: string): string | null {
  const lines = paneText.split("\n")
  const sepIdx = findChromeSeparator(lines, 10)
  if (sepIdx < 1) return null

  const statusLine = lines[sepIdx - 1].trim()
  if (!statusLine) return null

  // Check if the first character is a spinner
  const chars = Array.from(statusLine)
  const firstChar = chars[0]
  if (firstChar && STATUS_SPINNERS.has(firstChar)) {
    // Return the rest of the line after the spinner, trimmed
    const rest = chars.slice(1).join("").trim()
    return rest || null
  }

  return null
}

/**
 * Strip the Claude Code chrome (bottom bar area) from captured pane lines.
 * Finds the topmost separator among the last 10 lines and removes
 * everything from that line onward.
 */
export function stripPaneChrome(lines: string[]): string[] {
  if (lines.length === 0) return lines

  const searchStart = Math.max(0, lines.length - 10)
  let topmostSep = -1
  for (let i = searchStart; i < lines.length; i++) {
    if (/─{20,}/.test(lines[i])) {
      if (topmostSep === -1 || i < topmostSep) {
        topmostSep = i
      }
    }
  }

  if (topmostSep === -1) return lines
  return lines.slice(0, topmostSep)
}

/**
 * Extract bash command output from a pane.
 * Searches from bottom up for a line containing "❯ command" or "$ command",
 * then returns that line and everything below it (before chrome).
 */
export function extractBashOutput(paneText: string, command: string): string | null {
  const lines = paneText.split("\n")
  const stripped = stripPaneChrome(lines)
  if (stripped.length === 0) return null

  // Search from bottom up for the command invocation
  for (let i = stripped.length - 1; i >= 0; i--) {
    const line = stripped[i]
    // Match "! command" pattern (Claude Code uses ! prefix for bash)
    if (line.includes(`! ${command}`) || line.includes(`❯ ${command}`) || line.includes(`$ ${command}`)) {
      const output = stripped.slice(i).join("\n")
      return output || null
    }
  }
  return null
}

/**
 * Parse usage/cost output from Claude Code's /usage command.
 * Looks for lines containing cost/token/usage info.
 */
export function parseUsageOutput(paneText: string): UsageInfo | null {
  const lines = paneText.split("\n")
  const stripped = stripPaneChrome(lines)
  if (stripped.length === 0) return null

  const usageLines: string[] = []
  let inUsage = false

  for (const line of stripped) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (inUsage) continue
      continue
    }

    // Detect usage-related lines by common keywords
    if (/cost|token|usage|input|output|cache|total|\$/i.test(trimmed)) {
      inUsage = true
      usageLines.push(trimmed)
    }
    else if (inUsage) {
      // Keep collecting until we hit a non-usage line
      if (/^\s*[─━─\-]{5,}/.test(trimmed)) {
        // Separator line, skip
        continue
      }
      // If it looks like a continuation (indented or has numbers), include it
      if (/\d/.test(trimmed) || line.startsWith("  ")) {
        usageLines.push(trimmed)
      }
      else {
        break
      }
    }
  }

  if (usageLines.length === 0) return null

  return {
    rawText: usageLines.join("\n"),
    parsedLines: usageLines,
  }
}
