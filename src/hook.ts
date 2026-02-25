/**
 * HTTP server for Claude Code session tracking hooks.
 *
 * Port of hook.py. Provides:
 *   - startHookServer(port): Bun HTTP server that receives SessionStart hook events
 *   - installHook(port): Installs the hook into ~/.claude/settings.json
 *   - hookMain(): CLI entry point (reads JSON from stdin for command-type hooks)
 *
 * Two modes:
 *   1. HTTP mode: Claude Code sends HTTP POST to http://localhost:PORT/hook
 *      Installed as: {"type":"http","url":"http://localhost:PORT/hook","timeout":5}
 *   2. Command mode: Claude Code spawns this as subprocess, passes JSON via stdin
 *      Installed as: {"type":"command","command":"bun run /path/hook.ts","timeout":5}
 *
 * HTTP mode requires matching the tmux window by CWD (since TMUX_PANE isn't available).
 * Command mode uses TMUX_PANE env var for exact window matching (like Python).
 */

import { existsSync, readFileSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"
import { spawnSync } from "bun"
import { atomicWriteJson, ccbotDir } from "./utils"
import { config } from "./config"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CLAUDE_SETTINGS_FILE = join(homedir(), ".claude", "settings.json")
const HOOK_COMMAND_SUFFIX = "ccbot hook"

export const DEFAULT_HOOK_PORT = parseInt(Bun.env.HOOK_PORT ?? "33773")

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readSessionMap(): Record<string, Record<string, string>> {
  const mapFile = join(ccbotDir(), "session_map.json")
  if (!existsSync(mapFile)) return {}
  try {
    return JSON.parse(readFileSync(mapFile, "utf-8"))
  }
  catch {
    return {}
  }
}

async function writeSessionMapEntry(
  sessionWindowKey: string,
  sessionId: string,
  cwd: string,
  windowName: string,
): Promise<void> {
  const mapFile = join(ccbotDir(), "session_map.json")
  mkdirSync(dirname(mapFile), { recursive: true })

  // Read-modify-write (no fcntl in Bun, but race is rare in practice)
  const sessionMap = readSessionMap()
  sessionMap[sessionWindowKey] = { session_id: sessionId, cwd, window_name: windowName }
  atomicWriteJson(mapFile, sessionMap)
}

/** Find tmux window that matches the given cwd. */
async function findWindowByCwd(cwd: string): Promise<{ windowId: string; windowName: string } | null> {
  const sessionName = config.tmuxSessionName
  const proc = Bun.spawnSync(
    ["tmux", "list-windows", "-t", sessionName, "-F", "#{window_id}\t#{window_name}\t#{pane_current_path}"],
    { stdout: "pipe", stderr: "pipe" },
  )
  if (proc.exitCode !== 0) return null
  const output = new TextDecoder().decode(proc.stdout).trimEnd()
  if (!output) return null

  for (const line of output.split("\n")) {
    const parts = line.split("\t")
    if (parts.length < 3) continue
    const [windowId, windowName, panePath] = parts as [string, string, string, ...string[]]
    if (panePath === cwd || cwd.startsWith(panePath + "/") || panePath.startsWith(cwd + "/")) {
      return { windowId, windowName }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Core hook processing
// ---------------------------------------------------------------------------

async function processHookEvent(payload: Record<string, unknown>): Promise<string> {
  const sessionId = (payload.session_id as string) ?? ""
  const cwd = (payload.cwd as string) ?? ""
  const event = (payload.hook_event_name as string) ?? ""

  if (!sessionId || !event) return "empty session_id or event"
  if (!UUID_RE.test(sessionId)) return `invalid session_id: ${sessionId}`
  if (cwd && !cwd.startsWith("/")) return `cwd not absolute: ${cwd}`
  if (event !== "SessionStart") return `ignored event: ${event}`

  // Determine session:window key
  const sessionName = config.tmuxSessionName
  let sessionWindowKey: string
  let windowName: string

  // Try TMUX_PANE if available (command hook mode)
  const paneId = Bun.env.TMUX_PANE ?? ""
  if (paneId) {
    const result = Bun.spawnSync(
      ["tmux", "display-message", "-t", paneId, "-p", "#{session_name}:#{window_id}:#{window_name}"],
      { stdout: "pipe", stderr: "pipe" },
    )
    const raw = new TextDecoder().decode(result.stdout).trim()
    const parts = raw.split(":", 3)
    if (parts.length >= 3) {
      const [, windowId, wname] = parts as [string, string, string, ...string[]]
      sessionWindowKey = `${sessionName}:${windowId}`
      windowName = wname ?? ""
    }
    else {
      return `failed to parse tmux output: ${raw}`
    }
  }
  else {
    // HTTP mode: match by CWD
    const win = await findWindowByCwd(cwd)
    if (!win) {
      // Store without window ID as fallback (session_id keyed by cwd hash)
      const cwdKey = cwd.replace(/\//g, "-")
      sessionWindowKey = `${sessionName}:cwd:${cwdKey}`
      windowName = ""
    }
    else {
      sessionWindowKey = `${sessionName}:${win.windowId}`
      windowName = win.windowName
    }
  }

  await writeSessionMapEntry(sessionWindowKey, sessionId, cwd, windowName)
  console.log(`Hook: updated session_map ${sessionWindowKey} -> session_id=${sessionId} cwd=${cwd}`)
  return "ok"
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

export function startHookServer(port = DEFAULT_HOOK_PORT): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)

      if (req.method === "POST" && url.pathname === "/hook") {
        let payload: Record<string, unknown>
        try {
          payload = await req.json() as Record<string, unknown>
        }
        catch {
          return new Response("Bad Request: invalid JSON", { status: 400 })
        }

        const result = await processHookEvent(payload).catch(e => `error: ${e}`)
        return new Response(JSON.stringify({ result }), {
          headers: { "Content-Type": "application/json" },
        })
      }

      if (req.method === "GET" && url.pathname === "/health") {
        return new Response("ok")
      }

      return new Response("Not Found", { status: 404 })
    },
  })

  console.log(`Hook server listening on http://localhost:${port}`)
  return server
}

// ---------------------------------------------------------------------------
// Install hook in Claude settings
// ---------------------------------------------------------------------------

function isHookInstalled(settings: Record<string, unknown>): boolean {
  const hooks = (settings.hooks as Record<string, unknown>) ?? {}
  const sessionStart = (hooks.SessionStart as unknown[]) ?? []

  for (const entry of sessionStart) {
    if (!entry || typeof entry !== "object") continue
    const innerHooks = ((entry as any).hooks as unknown[]) ?? []
    for (const h of innerHooks) {
      if (!h || typeof h !== "object") continue
      const cmd: string = (h as any).command ?? ""
      const url: string = (h as any).url ?? ""
      if (cmd === HOOK_COMMAND_SUFFIX || cmd.endsWith("/" + HOOK_COMMAND_SUFFIX)) return true
      if (url.includes("/hook")) return true
    }
  }
  return false
}

export function installHook(mode: "command" | "http" = "command", port = DEFAULT_HOOK_PORT): number {
  const settingsFile = CLAUDE_SETTINGS_FILE
  mkdirSync(dirname(settingsFile), { recursive: true })

  let settings: Record<string, unknown> = {}
  if (existsSync(settingsFile)) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, "utf-8"))
    }
    catch (e) {
      console.error(`Error reading ${settingsFile}: ${e}`)
      return 1
    }
  }

  if (isHookInstalled(settings)) {
    console.log(`Hook already installed in ${settingsFile}`)
    return 0
  }

  let hookConfig: Record<string, unknown>
  if (mode === "http") {
    hookConfig = { type: "http", url: `http://localhost:${port}/hook`, timeout: 5 }
    console.log(`Installing HTTP hook: ${hookConfig.url}`)
  }
  else {
    // Find the current script path
    const scriptPath = import.meta.url.replace("file://", "")
    const hookCommand = `bun run ${scriptPath}`
    hookConfig = { type: "command", command: hookCommand, timeout: 5 }
    console.log(`Installing command hook: ${hookCommand}`)
  }

  if (!settings.hooks) settings.hooks = {}
  const hooksSection = settings.hooks as Record<string, unknown>
  if (!hooksSection.SessionStart) hooksSection.SessionStart = []
  ;(hooksSection.SessionStart as unknown[]).push({ hooks: [hookConfig] })

  try {
    atomicWriteJson(settingsFile, settings)
  }
  catch (e) {
    console.error(`Error writing ${settingsFile}: ${e}`)
    return 1
  }

  console.log(`Hook installed successfully in ${settingsFile}`)
  return 0
}

// ---------------------------------------------------------------------------
// CLI entry point (command hook: reads JSON from stdin)
// ---------------------------------------------------------------------------

export async function hookMain(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.includes("--install")) {
    const httpIdx = args.indexOf("--http")
    if (httpIdx >= 0) {
      const portArg = args[httpIdx + 1]
      const port = portArg ? parseInt(portArg) : DEFAULT_HOOK_PORT
      process.exit(installHook("http", port))
    }
    process.exit(installHook("command"))
  }

  // Read JSON payload from stdin
  let payload: Record<string, unknown>
  try {
    const stdin = await new Response(Bun.stdin.stream()).text()
    payload = JSON.parse(stdin)
  }
  catch (e) {
    console.error(`Failed to parse stdin JSON: ${e}`)
    return
  }

  await processHookEvent(payload)
}

// Run as CLI when executed directly
if (import.meta.main) {
  hookMain().catch(e => {
    console.error(e)
    process.exit(1)
  })
}
