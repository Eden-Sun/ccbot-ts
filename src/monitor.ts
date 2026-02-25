/**
 * Session monitoring service — watches JSONL files for new messages.
 *
 * Polls session files using byte-offset tracking for incremental reads.
 * Maps tmux windows to Claude sessions via session_map.json.
 * Emits NewMessage objects to a callback when new messages arrive.
 */

import { existsSync, statSync } from "fs"
import { join, resolve } from "path"
import { config } from "./config"
import { MonitorState } from "./monitorState"
import { sessionManager } from "./session"
import { tmuxManager } from "./tmux"
import { TranscriptParser } from "./transcript"
import { readCwdFromJsonl } from "./utils"
import type { NewMessage, SessionInfo, TrackedSession } from "./types"

type MessageCallback = (msg: NewMessage) => Promise<void>

export class SessionMonitor {
  private projectsPath: string
  private pollInterval: number
  private state: MonitorState
  private _running = false
  private _task: ReturnType<typeof setInterval> | null = null
  private _messageCallback: MessageCallback | null = null
  private _pendingTools: Map<string, Map<string, any>> = new Map()
  private _lastSessionMap: Map<string, string> = new Map()
  private _fileMtimes: Map<string, number> = new Map()

  constructor(opts: { projectsPath?: string; pollInterval?: number; stateFile?: string } = {}) {
    this.projectsPath = opts.projectsPath ?? config.claudeProjectsPath
    this.pollInterval = opts.pollInterval ?? config.monitorPollInterval
    this.state = new MonitorState(opts.stateFile ?? config.monitorStateFile)
    this.state.load()
  }

  setMessageCallback(cb: MessageCallback): void {
    this._messageCallback = cb
  }

  private async _getActiveCwds(): Promise<Set<string>> {
    const cwds = new Set<string>()
    const windows = await tmuxManager.listWindows()
    for (const w of windows) {
      try { cwds.add(resolve(w.cwd)) }
      catch { cwds.add(w.cwd) }
    }
    return cwds
  }

  private async scanProjects(): Promise<SessionInfo[]> {
    const activeCwds = await this._getActiveCwds()
    if (activeCwds.size === 0) return []

    if (!existsSync(this.projectsPath)) return []

    const sessions: SessionInfo[] = []

    for (const entry of await Array.fromAsync(
      this._iterDir(this.projectsPath),
    )) {
      if (!entry.isDir) continue
      const projectDir = join(this.projectsPath, entry.name)

      const indexFile = join(projectDir, "sessions-index.json")
      const indexedIds = new Set<string>()
      let originalPath = ""

      if (existsSync(indexFile)) {
        try {
          const indexData = JSON.parse(await Bun.file(indexFile).text())
          originalPath = indexData.originalPath ?? ""
          const entries: any[] = indexData.entries ?? []

          for (const e of entries) {
            const sessionId: string = e.sessionId ?? ""
            const fullPath: string = e.fullPath ?? ""
            const projectPath: string = e.projectPath ?? originalPath

            if (!sessionId || !fullPath) continue

            let normPp: string
            try { normPp = resolve(projectPath) }
            catch { normPp = projectPath }

            if (!activeCwds.has(normPp)) continue
            indexedIds.add(sessionId)
            if (existsSync(fullPath)) {
              sessions.push({ sessionId, filePath: fullPath })
            }
          }
        }
        catch {}
      }

      // Un-indexed .jsonl files
      try {
        const g = new Bun.Glob("*.jsonl")
        for await (const filename of g.scan({ cwd: projectDir })) {
          const sessionId = filename.replace(/\.jsonl$/, "")
          if (indexedIds.has(sessionId)) continue

          let fileProjectPath = originalPath
          if (!fileProjectPath) {
            const jsonlPath = join(projectDir, filename)
            fileProjectPath = readCwdFromJsonl(jsonlPath) ?? ""
          }
          if (!fileProjectPath) {
            const dirName = entry.name
            if (dirName.startsWith("-")) fileProjectPath = dirName.replace(/-/g, "/")
          }

          let normFp: string
          try { normFp = resolve(fileProjectPath) }
          catch { normFp = fileProjectPath }

          if (!activeCwds.has(normFp)) continue
          sessions.push({ sessionId, filePath: join(projectDir, filename) })
        }
      }
      catch {}
    }

    return sessions
  }

  private async *_iterDir(dir: string): AsyncGenerator<{ name: string; isDir: boolean }> {
    const g = new Bun.Glob("*")
    for await (const name of g.scan({ cwd: dir, onlyFiles: false })) {
      const fullPath = join(dir, name)
      try {
        const stat = statSync(fullPath)
        yield { name, isDir: stat.isDirectory() }
      }
      catch {}
    }
  }

  private async _readNewLines(
    session: TrackedSession,
    filePath: string,
  ): Promise<Array<Record<string, any>>> {
    const newEntries: Array<Record<string, any>> = []

    try {
      const file = Bun.file(filePath)
      const fileSize = file.size

      if (session.lastByteOffset > fileSize) {
        session.lastByteOffset = 0
      }

      const text = await file.text()
      const encoder = new TextEncoder()

      // Find the byte offset position in the text
      let bytePos = 0
      let charPos = 0
      const textBytes = encoder.encode(text)

      if (session.lastByteOffset > 0) {
        bytePos = session.lastByteOffset
        // Find the char position corresponding to this byte offset
        // Use TextDecoder to decode up to bytePos
        const decodedUpTo = new TextDecoder().decode(textBytes.slice(0, bytePos))
        charPos = decodedUpTo.length

        // Check if we're mid-line (next char should be '{')
        const nextChar = text[charPos]
        if (nextChar && nextChar !== "{" && nextChar !== "\n") {
          // Mid-line — find next newline
          const nlIdx = text.indexOf("\n", charPos)
          if (nlIdx >= 0) {
            charPos = nlIdx + 1
            session.lastByteOffset = encoder.encode(text.slice(0, charPos)).length
          }
          return []
        }
      }

      const remaining = text.slice(charPos)
      const lines = remaining.split("\n")
      let currentOffset = session.lastByteOffset
      let safeOffset = currentOffset

      for (const line of lines) {
        const lineBytes = encoder.encode(line + "\n").length
        if (!line.trim()) {
          currentOffset += lineBytes
          safeOffset = currentOffset
          continue
        }
        try {
          const data = JSON.parse(line)
          if (data) {
            newEntries.push(data)
            currentOffset += lineBytes
            safeOffset = currentOffset
          }
        }
        catch {
          // Partial line — stop
          break
        }
      }

      session.lastByteOffset = safeOffset
    }
    catch {}

    return newEntries
  }

  async checkForUpdates(activeSessionIds: Set<string>): Promise<NewMessage[]> {
    const newMessages: NewMessage[] = []
    const sessions = await this.scanProjects()

    for (const sessionInfo of sessions) {
      if (!activeSessionIds.has(sessionInfo.sessionId)) continue

      try {
        let tracked = this.state.getSession(sessionInfo.sessionId)

        if (!tracked) {
          let fileSize = 0
          let mtime = 0
          try {
            const st = statSync(sessionInfo.filePath)
            fileSize = st.size
            mtime = st.mtimeMs
          }
          catch {}
          tracked = {
            sessionId: sessionInfo.sessionId,
            filePath: sessionInfo.filePath,
            lastByteOffset: fileSize,
          }
          this.state.updateSession(tracked)
          this._fileMtimes.set(sessionInfo.sessionId, mtime)
          continue
        }

        let currentMtime = 0
        let currentSize = 0
        try {
          const st = statSync(sessionInfo.filePath)
          currentMtime = st.mtimeMs
          currentSize = st.size
        }
        catch {
          continue
        }

        const lastMtime = this._fileMtimes.get(sessionInfo.sessionId) ?? 0
        if (currentMtime <= lastMtime && currentSize <= tracked.lastByteOffset) continue

        const newEntries = await this._readNewLines(tracked, sessionInfo.filePath)
        this._fileMtimes.set(sessionInfo.sessionId, currentMtime)

        if (newEntries.length === 0) {
          this.state.updateSession(tracked)
          continue
        }

        const carry = this._pendingTools.get(sessionInfo.sessionId) ?? new Map()
        const [parsedEntries, remaining] = TranscriptParser.parseEntries(newEntries, carry)

        if (remaining.size > 0) {
          this._pendingTools.set(sessionInfo.sessionId, remaining)
        }
        else {
          this._pendingTools.delete(sessionInfo.sessionId)
        }

        for (const entry of parsedEntries) {
          if (!entry.text && !entry.imageData) continue
          if (entry.role === "user" && !config.showUserMessages) continue
          newMessages.push({
            sessionId: sessionInfo.sessionId,
            text: entry.text,
            isComplete: true,
            contentType: entry.contentType,
            toolUseId: entry.toolUseId,
            role: entry.role,
            toolName: entry.toolName,
            imageData: entry.imageData,
          })
        }

        this.state.updateSession(tracked)
      }
      catch {}
    }

    this.state.saveIfDirty()
    return newMessages
  }

  private async _loadCurrentSessionMap(): Promise<Map<string, string>> {
    const windowToSession = new Map<string, string>()
    if (!existsSync(config.sessionMapFile)) return windowToSession

    try {
      const text = await Bun.file(config.sessionMapFile).text()
      const sessionMap = JSON.parse(text) as Record<string, Record<string, string>>
      const prefix = `${config.tmuxSessionName}:`

      for (const [key, info] of Object.entries(sessionMap)) {
        if (!key.startsWith(prefix)) continue
        const windowKey = key.slice(prefix.length)
        const sessionId = info.session_id ?? ""
        if (sessionId) windowToSession.set(windowKey, sessionId)
      }
    }
    catch {}

    return windowToSession
  }

  private async _cleanupAllStaleSessions(): Promise<void> {
    const currentMap = await this._loadCurrentSessionMap()
    const activeSessionIds = new Set(currentMap.values())

    const stale: string[] = []
    for (const sessionId of this.state.trackedSessions.keys()) {
      if (!activeSessionIds.has(sessionId)) stale.push(sessionId)
    }

    if (stale.length > 0) {
      for (const id of stale) {
        this.state.removeSession(id)
        this._fileMtimes.delete(id)
      }
      this.state.saveIfDirty()
    }
  }

  private async _detectAndCleanupChanges(): Promise<Map<string, string>> {
    const currentMap = await this._loadCurrentSessionMap()
    const sessionsToRemove = new Set<string>()

    for (const [windowId, oldSessionId] of this._lastSessionMap) {
      const newSessionId = currentMap.get(windowId)
      if (newSessionId && newSessionId !== oldSessionId) {
        sessionsToRemove.add(oldSessionId)
      }
    }

    const oldWindows = new Set(this._lastSessionMap.keys())
    const currentWindows = new Set(currentMap.keys())
    for (const wid of oldWindows) {
      if (!currentWindows.has(wid)) {
        const oldSid = this._lastSessionMap.get(wid)!
        sessionsToRemove.add(oldSid)
      }
    }

    if (sessionsToRemove.size > 0) {
      for (const id of sessionsToRemove) {
        this.state.removeSession(id)
        this._fileMtimes.delete(id)
      }
      this.state.saveIfDirty()
    }

    this._lastSessionMap = currentMap
    return currentMap
  }

  private async _monitorLoop(): Promise<void> {
    await this._cleanupAllStaleSessions()
    this._lastSessionMap = await this._loadCurrentSessionMap()

    while (this._running) {
      try {
        await sessionManager.loadSessionMap()

        const currentMap = await this._detectAndCleanupChanges()
        const activeSessionIds = new Set(currentMap.values())

        const newMessages = await this.checkForUpdates(activeSessionIds)

        for (const msg of newMessages) {
          if (this._messageCallback) {
            try {
              await this._messageCallback(msg)
            }
            catch (e) {
              console.error("Message callback error:", e)
            }
          }
        }
      }
      catch (e) {
        console.error("Monitor loop error:", e)
      }

      await Bun.sleep(this.pollInterval * 1000)
    }
  }

  start(): void {
    if (this._running) return
    this._running = true
    this._monitorLoop().catch(e => console.error("Monitor crashed:", e))
  }

  stop(): void {
    this._running = false
    this.state.save()
  }
}
