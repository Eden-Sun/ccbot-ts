import { homedir } from "os"
import { join, dirname } from "path"
import { existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync, readFileSync } from "fs"
import { randomBytes } from "crypto"

/**
 * Resolve the ccbot config directory.
 * CCBOT_DIR env > ~/.ccbot
 */
export function ccbotDir(): string {
  const dir = Bun.env.CCBOT_DIR || join(homedir(), ".ccbot")
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

/**
 * Write JSON atomically: write to temp file then rename.
 * This prevents partial reads on crash.
 */
export function atomicWriteJson(filePath: string, data: unknown, indent: number = 2): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const tmp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(data, null, indent) + "\n", "utf-8")
    renameSync(tmp, filePath)
  } catch (err) {
    // Clean up temp file on failure
    try { unlinkSync(tmp) } catch {}
    throw err
  }
}

/**
 * Read cwd from a JSONL file.
 * Scans lines for the first JSON object that has a "cwd" field.
 */
export function readCwdFromJsonl(filePath: string): string | null {
  if (!existsSync(filePath)) return null
  const content = readFileSync(filePath, "utf-8")
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed)
      if (obj && typeof obj.cwd === "string") {
        return obj.cwd
      }
    } catch {
      // skip malformed lines
    }
  }
  return null
}

/**
 * Split a long text into Telegram-safe chunks (<= maxLength).
 * Prefers splitting at newline boundaries.
 */
export function splitMessage(text: string, maxLength: number = 4096): string[] {
  if (text.length <= maxLength) return [text]

  const parts: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      parts.push(remaining)
      break
    }

    // Try to find a newline to split at
    let splitAt = remaining.lastIndexOf("\n", maxLength)
    if (splitAt <= 0) {
      // No good newline boundary, just cut at maxLength
      splitAt = maxLength
    }

    parts.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt)
    // Strip leading newline from next chunk
    if (remaining.startsWith("\n")) {
      remaining = remaining.slice(1)
    }
  }

  return parts
}
