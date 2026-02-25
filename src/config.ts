import { homedir } from "os"
import { join, resolve } from "path"
import { existsSync, readFileSync, mkdirSync } from "fs"
import { ccbotDir } from "./utils"

/**
 * Application configuration loaded from environment variables.
 * Singleton exported as `config`.
 */
class Config {
  readonly configDir: string
  readonly telegramBotToken: string
  readonly allowedUsers: Set<number>
  readonly tmuxSessionName: string
  readonly tmuxMainWindowName = "__main__"
  readonly claudeCommand: string
  readonly stateFile: string
  readonly sessionMapFile: string
  readonly monitorStateFile: string
  readonly claudeProjectsPath: string
  readonly monitorPollInterval: number
  readonly showUserMessages = true
  readonly showHiddenDirs: boolean

  constructor() {
    this.configDir = ccbotDir()
    mkdirSync(this.configDir, { recursive: true })

    // Load .env from config dir as fallback (Bun auto-loads local .env)
    const globalEnv = join(this.configDir, ".env")
    if (existsSync(globalEnv)) {
      const lines = readFileSync(globalEnv, "utf-8").split("\n")
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue
        const eq = trimmed.indexOf("=")
        if (eq < 0) continue
        const key = trimmed.slice(0, eq).trim()
        const val = trimmed.slice(eq + 1).trim()
        // Don't override existing env vars (local .env takes priority via Bun)
        if (!Bun.env[key]) {
          Bun.env[key] = val
        }
      }
    }

    this.telegramBotToken = Bun.env.TELEGRAM_BOT_TOKEN ?? ""
    if (!this.telegramBotToken) {
      throw new Error("TELEGRAM_BOT_TOKEN environment variable is required")
    }

    const allowedUsersStr = Bun.env.ALLOWED_USERS ?? ""
    if (!allowedUsersStr) {
      throw new Error("ALLOWED_USERS environment variable is required")
    }
    this.allowedUsers = new Set<number>()
    for (const uid of allowedUsersStr.split(",")) {
      const trimmed = uid.trim()
      if (!trimmed) continue
      const num = Number(trimmed)
      if (!Number.isInteger(num)) {
        throw new Error(`ALLOWED_USERS contains non-numeric value: ${trimmed}`)
      }
      this.allowedUsers.add(num)
    }

    this.tmuxSessionName = Bun.env.TMUX_SESSION_NAME ?? "ccbot"
    this.claudeCommand = Bun.env.CLAUDE_COMMAND ?? "claude"

    this.stateFile = join(this.configDir, "state.json")
    this.sessionMapFile = join(this.configDir, "session_map.json")
    this.monitorStateFile = join(this.configDir, "monitor_state.json")

    // Claude projects path resolution
    const customProjectsPath = Bun.env.CCBOT_CLAUDE_PROJECTS_PATH
    const claudeConfigDir = Bun.env.CLAUDE_CONFIG_DIR
    if (customProjectsPath) {
      this.claudeProjectsPath = customProjectsPath
    } else if (claudeConfigDir) {
      this.claudeProjectsPath = join(claudeConfigDir, "projects")
    } else {
      this.claudeProjectsPath = join(homedir(), ".claude", "projects")
    }

    this.monitorPollInterval = parseFloat(Bun.env.MONITOR_POLL_INTERVAL ?? "2.0")
    this.showHiddenDirs = (Bun.env.CCBOT_SHOW_HIDDEN_DIRS ?? "").toLowerCase() === "true"
  }

  isUserAllowed(userId: number): boolean {
    return this.allowedUsers.has(userId)
  }
}

export const config = new Config()
