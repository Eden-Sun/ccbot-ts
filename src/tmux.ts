import type { TmuxWindow } from "./types"
import { config } from "./config"

class TmuxManager {
  sessionName: string

  constructor(sessionName?: string) {
    this.sessionName = sessionName ?? config.tmuxSessionName
  }

  private async execTmux(args: string[]): Promise<string> {
    const proc = Bun.spawn(["tmux", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    return stdout.trimEnd()
  }

  getSession(): string | null {
    const proc = Bun.spawnSync(["tmux", "has-session", "-t", this.sessionName], {
      stdout: "pipe",
      stderr: "pipe",
    })
    return proc.exitCode === 0 ? this.sessionName : null
  }

  getOrCreateSession(): string {
    if (this.getSession()) return this.sessionName
    Bun.spawnSync(["tmux", "new-session", "-d", "-s", this.sessionName, "-n", "__main__"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    return this.sessionName
  }

  async listWindows(): Promise<TmuxWindow[]> {
    const session = this.getSession()
    if (!session) return []

    const format = "#{window_id}\t#{window_name}\t#{pane_current_path}\t#{pane_current_command}"
    let output: string
    try {
      output = await this.execTmux(["list-windows", "-t", session, "-F", format])
    }
    catch {
      return []
    }

    if (!output) return []

    const windows: TmuxWindow[] = []
    for (const line of output.split("\n")) {
      if (!line.trim()) continue
      const parts = line.split("\t")
      if (parts.length < 3) continue
      const [windowId, windowName, cwd, paneCurrentCommand] = parts
      if (windowName === "__main__") continue
      windows.push({
        windowId,
        windowName,
        cwd,
        paneCurrentCommand: paneCurrentCommand ?? "",
      })
    }
    return windows
  }

  async findWindowByName(name: string): Promise<TmuxWindow | null> {
    const windows = await this.listWindows()
    return windows.find(w => w.windowName === name) ?? null
  }

  async findWindowById(windowId: string): Promise<TmuxWindow | null> {
    const windows = await this.listWindows()
    return windows.find(w => w.windowId === windowId) ?? null
  }

  async capturPane(windowId: string, withAnsi = false): Promise<string | null> {
    const args = withAnsi
      ? ["capture-pane", "-e", "-p", "-t", windowId]
      : ["capture-pane", "-p", "-t", windowId]

    try {
      return await this.execTmux(args)
    }
    catch {
      return null
    }
  }

  async sendKeys(windowId: string, text: string, enter = true, literal = true): Promise<boolean> {
    try {
      if (literal && enter) {
        // Send text literally, sleep, then send Enter
        await this.execTmux(["send-keys", "-t", windowId, "-l", text])
        await Bun.sleep(500)
        await this.execTmux(["send-keys", "-t", windowId, "Enter"])
        return true
      }

      if (literal) {
        // text starts with "!" handling
        if (text.startsWith("!")) {
          await this.execTmux(["send-keys", "-t", windowId, "-l", "!"])
          await Bun.sleep(1000)
          if (text.length > 1) {
            await this.execTmux(["send-keys", "-t", windowId, "-l", text.slice(1)])
          }
        }
        else {
          await this.execTmux(["send-keys", "-t", windowId, "-l", text])
        }
        return true
      }

      // Non-literal: special keys sent directly
      if (enter) {
        await this.execTmux(["send-keys", "-t", windowId, text, "Enter"])
      }
      else {
        await this.execTmux(["send-keys", "-t", windowId, text])
      }
      return true
    }
    catch {
      return false
    }
  }

  async killWindow(windowId: string): Promise<boolean> {
    try {
      await this.execTmux(["kill-window", "-t", windowId])
      return true
    }
    catch {
      return false
    }
  }

  async createWindow(
    workDir: string,
    windowName?: string,
    startClaude = false,
  ): Promise<[boolean, string, string, string]> {
    const session = this.getOrCreateSession()

    // Generate a default name from workDir if none given
    let baseName = windowName ?? workDir.split("/").pop() ?? "window"
    let finalName = baseName

    // Deduplicate name
    const existing = await this.listWindows()
    const existingNames = new Set(existing.map(w => w.windowName))
    if (existingNames.has(finalName)) {
      let counter = 2
      while (existingNames.has(`${baseName}-${counter}`)) {
        counter++
      }
      finalName = `${baseName}-${counter}`
    }

    try {
      await this.execTmux([
        "new-window",
        "-t", session,
        "-n", finalName,
        "-c", workDir,
      ])
    }
    catch (e) {
      return [false, `Failed to create window: ${e}`, "", ""]
    }

    // Find the newly created window
    const win = await this.findWindowByName(finalName)
    if (!win) {
      return [false, "Window created but not found", finalName, ""]
    }

    if (startClaude) {
      await Bun.sleep(500)
      await this.sendKeys(win.windowId, config.claudeCommand, true, true)
    }

    return [true, "Window created", finalName, win.windowId]
  }
}

export const tmuxManager = new TmuxManager()
