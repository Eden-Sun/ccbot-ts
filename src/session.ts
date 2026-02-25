/**
 * Claude Code session management — the core state hub.
 *
 * Manages:
 *   window_states: window_id → {session_id, cwd, window_name}
 *   thread_bindings: user_id → {thread_id → window_id}
 *   user_window_offsets: user_id → {window_id → byte_offset}
 *   group_chat_ids: "user_id:thread_id" → group chat_id
 *   window_display_names: window_id → window_name
 */

import { join, resolve } from "path"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { config } from "./config"
import { tmuxManager } from "./tmux"
import { TranscriptParser } from "./transcript"
import { atomicWriteJson } from "./utils"
import type { ClaudeSession } from "./types"

interface WindowState {
  sessionId: string
  cwd: string
  windowName: string
}

function isWindowId(key: string): boolean {
  return key.startsWith("@") && key.length > 1 && /^\d+$/.test(key.slice(1))
}

class SessionManager {
  windowStates: Map<string, WindowState> = new Map()
  userWindowOffsets: Map<number, Map<string, number>> = new Map()
  threadBindings: Map<number, Map<number, string>> = new Map()
  windowDisplayNames: Map<string, string> = new Map()
  groupChatIds: Map<string, number> = new Map()
  private _saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    this._loadState()
  }

  private _doSave(): void {
    this._saveTimer = null
    const windowStatesObj: Record<string, object> = {}
    for (const [k, v] of this.windowStates) {
      const d: Record<string, string> = { session_id: v.sessionId, cwd: v.cwd }
      if (v.windowName) d.window_name = v.windowName
      windowStatesObj[k] = d
    }

    const userWindowOffsetsObj: Record<string, Record<string, number>> = {}
    for (const [uid, offsets] of this.userWindowOffsets) {
      userWindowOffsetsObj[String(uid)] = Object.fromEntries(offsets)
    }

    const threadBindingsObj: Record<string, Record<string, string>> = {}
    for (const [uid, bindings] of this.threadBindings) {
      const inner: Record<string, string> = {}
      for (const [tid, wid] of bindings) inner[String(tid)] = wid
      threadBindingsObj[String(uid)] = inner
    }

    const groupChatIdsObj: Record<string, number> = {}
    for (const [k, v] of this.groupChatIds) groupChatIdsObj[k] = v

    atomicWriteJson(config.stateFile, {
      window_states: windowStatesObj,
      user_window_offsets: userWindowOffsetsObj,
      thread_bindings: threadBindingsObj,
      window_display_names: Object.fromEntries(this.windowDisplayNames),
      group_chat_ids: groupChatIdsObj,
    })
  }

  private _saveState(): void {
    if (this._saveTimer !== null) return
    this._saveTimer = setTimeout(() => this._doSave(), 50)
  }

  flushState(): void {
    if (this._saveTimer !== null) {
      clearTimeout(this._saveTimer)
      this._doSave()
    }
  }

  private _loadState(): void {
    if (!existsSync(config.stateFile)) return
    try {
      const raw = readFileSync(config.stateFile, "utf-8")
      const state = JSON.parse(raw)

      this.windowStates = new Map()
      for (const [k, v] of Object.entries(state.window_states ?? {})) {
        const d = v as Record<string, string>
        this.windowStates.set(k, {
          sessionId: d.session_id ?? "",
          cwd: d.cwd ?? "",
          windowName: d.window_name ?? "",
        })
      }

      this.userWindowOffsets = new Map()
      for (const [uid, offsets] of Object.entries(state.user_window_offsets ?? {})) {
        const m = new Map<string, number>()
        for (const [k, v] of Object.entries(offsets as Record<string, number>)) m.set(k, v)
        this.userWindowOffsets.set(Number(uid), m)
      }

      this.threadBindings = new Map()
      for (const [uid, bindings] of Object.entries(state.thread_bindings ?? {})) {
        const m = new Map<number, string>()
        for (const [tid, wid] of Object.entries(bindings as Record<string, string>)) {
          m.set(Number(tid), wid)
        }
        this.threadBindings.set(Number(uid), m)
      }

      this.windowDisplayNames = new Map(
        Object.entries(state.window_display_names ?? {}),
      )

      this.groupChatIds = new Map()
      for (const [k, v] of Object.entries(state.group_chat_ids ?? {})) {
        this.groupChatIds.set(k, Number(v))
      }
    }
    catch {
      this.windowStates = new Map()
      this.userWindowOffsets = new Map()
      this.threadBindings = new Map()
      this.windowDisplayNames = new Map()
      this.groupChatIds = new Map()
    }
  }

  // --- Display names ---

  getDisplayName(windowId: string): string {
    return this.windowDisplayNames.get(windowId) ?? windowId
  }

  // --- Group chat IDs (supergroup forum topic routing) ---

  setGroupChatId(userId: number, threadId: number | null, chatId: number): void {
    const tid = threadId ?? 0
    const key = `${userId}:${tid}`
    if (this.groupChatIds.get(key) !== chatId) {
      this.groupChatIds.set(key, chatId)
      this._saveState()
    }
  }

  resolveChatId(userId: number, threadId?: number | null): number {
    if (threadId != null) {
      const key = `${userId}:${threadId}`
      const groupId = this.groupChatIds.get(key)
      if (groupId != null) return groupId
    }
    return userId
  }

  // --- Window state ---

  getWindowState(windowId: string): WindowState {
    if (!this.windowStates.has(windowId)) {
      this.windowStates.set(windowId, { sessionId: "", cwd: "", windowName: "" })
    }
    return this.windowStates.get(windowId)!
  }

  clearWindowSession(windowId: string): void {
    const state = this.getWindowState(windowId)
    state.sessionId = ""
    this._saveState()
  }

  // --- Thread bindings ---

  bindThread(userId: number, threadId: number, windowId: string, windowName = ""): void {
    if (!this.threadBindings.has(userId)) this.threadBindings.set(userId, new Map())
    this.threadBindings.get(userId)!.set(threadId, windowId)
    if (windowName) this.windowDisplayNames.set(windowId, windowName)
    this._saveState()
  }

  unbindThread(userId: number, threadId: number): string | null {
    const bindings = this.threadBindings.get(userId)
    if (!bindings?.has(threadId)) return null
    const windowId = bindings.get(threadId)!
    bindings.delete(threadId)
    if (bindings.size === 0) this.threadBindings.delete(userId)
    this._saveState()
    return windowId
  }

  getWindowForThread(userId: number, threadId: number): string | null {
    return this.threadBindings.get(userId)?.get(threadId) ?? null
  }

  resolveWindowForThread(userId: number, threadId: number | null): string | null {
    if (threadId == null) return null
    return this.getWindowForThread(userId, threadId)
  }

  *iterThreadBindings(): Generator<[number, number, string]> {
    for (const [userId, bindings] of this.threadBindings) {
      for (const [threadId, windowId] of bindings) {
        yield [userId, threadId, windowId]
      }
    }
  }

  // --- User window offsets ---

  updateUserWindowOffset(userId: number, windowId: string, offset: number): void {
    if (!this.userWindowOffsets.has(userId)) this.userWindowOffsets.set(userId, new Map())
    this.userWindowOffsets.get(userId)!.set(windowId, offset)
    this._saveState()
  }

  getUserWindowOffset(userId: number, windowId: string): number {
    return this.userWindowOffsets.get(userId)?.get(windowId) ?? 0
  }

  // --- Session file path ---

  private _buildSessionFilePath(sessionId: string, cwd: string): string | null {
    if (!sessionId || !cwd) return null
    const encodedCwd = cwd.replace(/\//g, "-")
    return join(config.claudeProjectsPath, encodedCwd, `${sessionId}.jsonl`)
  }

  // --- Session resolution ---

  private async _getSessionDirect(sessionId: string, cwd: string): Promise<ClaudeSession | null> {
    let filePath = this._buildSessionFilePath(sessionId, cwd)

    // Fallback: glob search
    if (!filePath || !existsSync(filePath)) {
      const g = new Bun.Glob(`**/${sessionId}.jsonl`)
      const matches: string[] = []
      for await (const m of g.scan({ cwd: config.claudeProjectsPath, absolute: true })) {
        matches.push(m)
      }
      if (matches.length > 0) filePath = matches[0]!
      else return null
    }

    if (!filePath || !existsSync(filePath)) return null

    let summary = ""
    let lastUserMsg = ""
    let messageCount = 0

    try {
      const text = await Bun.file(filePath).text()
      for (const line of text.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue
        messageCount++
        try {
          const data = JSON.parse(trimmed)
          if (data.type === "summary" && data.summary) {
            summary = data.summary
          }
          else if (TranscriptParser.isUserMessage(data)) {
            const parsed = TranscriptParser.parseMessage(data)
            if (parsed?.text.trim()) lastUserMsg = parsed.text.trim()
          }
        }
        catch {}
      }
    }
    catch {
      return null
    }

    if (!summary) summary = lastUserMsg.slice(0, 50) || "Untitled"

    return {
      sessionId,
      summary,
      messageCount,
      filePath,
    }
  }

  async resolveSessionForWindow(windowId: string): Promise<ClaudeSession | null> {
    const state = this.getWindowState(windowId)
    if (!state.sessionId || !state.cwd) return null

    const session = await this._getSessionDirect(state.sessionId, state.cwd)
    if (session) return session

    state.sessionId = ""
    state.cwd = ""
    this._saveState()
    return null
  }

  findUsersForSession(sessionId: string): Array<[number, string, number]> {
    const result: Array<[number, string, number]> = []
    for (const [userId, threadId, windowId] of this.iterThreadBindings()) {
      const state = this.windowStates.get(windowId)
      if (state?.sessionId === sessionId) {
        result.push([userId, windowId, threadId])
      }
    }
    return result
  }

  // --- Session map ---

  async loadSessionMap(): Promise<void> {
    if (!existsSync(config.sessionMapFile)) return
    let sessionMap: Record<string, Record<string, string>>
    try {
      const text = await Bun.file(config.sessionMapFile).text()
      sessionMap = JSON.parse(text)
    }
    catch {
      return
    }

    const prefix = `${config.tmuxSessionName}:`
    const validWids = new Set<string>()
    let changed = false

    for (const [key, info] of Object.entries(sessionMap)) {
      if (!key.startsWith(prefix)) continue
      const windowId = key.slice(prefix.length)
      if (!isWindowId(windowId)) continue
      validWids.add(windowId)
      const newSid = info.session_id ?? ""
      const newCwd = info.cwd ?? ""
      const newWname = info.window_name ?? ""
      if (!newSid) continue

      const state = this.getWindowState(windowId)
      if (state.sessionId !== newSid || state.cwd !== newCwd) {
        state.sessionId = newSid
        state.cwd = newCwd
        changed = true
      }
      if (newWname) {
        state.windowName = newWname
        if (this.windowDisplayNames.get(windowId) !== newWname) {
          this.windowDisplayNames.set(windowId, newWname)
          changed = true
        }
      }
    }

    // Clean up stale window_states
    for (const wid of [...this.windowStates.keys()]) {
      if (wid && !validWids.has(wid)) {
        this.windowStates.delete(wid)
        changed = true
      }
    }

    if (changed) this._saveState()
  }

  async waitForSessionMapEntry(windowId: string, timeout = 5000, interval = 500): Promise<boolean> {
    const key = `${config.tmuxSessionName}:${windowId}`
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (existsSync(config.sessionMapFile)) {
        try {
          const text = await Bun.file(config.sessionMapFile).text()
          const sessionMap = JSON.parse(text)
          const info = sessionMap[key]
          if (info?.session_id) {
            await this.loadSessionMap()
            return true
          }
        }
        catch {}
      }
      await Bun.sleep(interval)
    }
    return false
  }

  async resolveStaleIds(): Promise<void> {
    const windows = await tmuxManager.listWindows()
    const liveByName = new Map<string, string>()
    const liveIds = new Set<string>()
    for (const w of windows) {
      liveByName.set(w.windowName, w.windowId)
      liveIds.add(w.windowId)
    }

    let changed = false
    const newWindowStates = new Map<string, WindowState>()

    for (const [key, ws] of this.windowStates) {
      if (isWindowId(key)) {
        if (liveIds.has(key)) {
          newWindowStates.set(key, ws)
        }
        else {
          const display = this.windowDisplayNames.get(key) ?? ws.windowName ?? key
          const newId = liveByName.get(display)
          if (newId) {
            newWindowStates.set(newId, ws)
            ws.windowName = display
            this.windowDisplayNames.set(newId, display)
            this.windowDisplayNames.delete(key)
            changed = true
          }
          else {
            changed = true
          }
        }
      }
      else {
        // Old format: key is window_name
        const newId = liveByName.get(key)
        if (newId) {
          ws.windowName = key
          newWindowStates.set(newId, ws)
          this.windowDisplayNames.set(newId, key)
          changed = true
        }
        else {
          changed = true
        }
      }
    }
    this.windowStates = newWindowStates

    // Migrate thread_bindings
    for (const [uid, bindings] of this.threadBindings) {
      const newBindings = new Map<number, string>()
      for (const [tid, val] of bindings) {
        if (isWindowId(val)) {
          if (liveIds.has(val)) {
            newBindings.set(tid, val)
          }
          else {
            const display = this.windowDisplayNames.get(val) ?? val
            const newId = liveByName.get(display)
            if (newId) {
              newBindings.set(tid, newId)
              this.windowDisplayNames.set(newId, display)
              changed = true
            }
            else {
              changed = true
            }
          }
        }
        else {
          const newId = liveByName.get(val)
          if (newId) {
            newBindings.set(tid, newId)
            this.windowDisplayNames.set(newId, val)
            changed = true
          }
          else {
            changed = true
          }
        }
      }
      this.threadBindings.set(uid, newBindings)
    }

    // Remove empty user entries
    for (const [uid, bindings] of this.threadBindings) {
      if (bindings.size === 0) this.threadBindings.delete(uid)
    }

    // Migrate user_window_offsets
    for (const [uid, offsets] of this.userWindowOffsets) {
      const newOffsets = new Map<string, number>()
      for (const [key, offset] of offsets) {
        if (isWindowId(key)) {
          if (liveIds.has(key)) {
            newOffsets.set(key, offset)
          }
          else {
            const display = this.windowDisplayNames.get(key) ?? key
            const newId = liveByName.get(display)
            if (newId) { newOffsets.set(newId, offset); changed = true }
            else changed = true
          }
        }
        else {
          const newId = liveByName.get(key)
          if (newId) { newOffsets.set(newId, offset); changed = true }
          else changed = true
        }
      }
      this.userWindowOffsets.set(uid, newOffsets)
    }

    if (changed) this._saveState()
    await this._cleanupStaleSessionMapEntries(liveIds)
  }

  private async _cleanupStaleSessionMapEntries(liveIds: Set<string>): Promise<void> {
    if (!existsSync(config.sessionMapFile)) return
    let sessionMap: Record<string, unknown>
    try {
      const text = await Bun.file(config.sessionMapFile).text()
      sessionMap = JSON.parse(text)
    }
    catch {
      return
    }

    const prefix = `${config.tmuxSessionName}:`
    const staleKeys = Object.keys(sessionMap).filter(
      k => k.startsWith(prefix) && isWindowId(k.slice(prefix.length)) && !liveIds.has(k.slice(prefix.length)),
    )
    if (staleKeys.length === 0) return
    for (const k of staleKeys) delete sessionMap[k]
    atomicWriteJson(config.sessionMapFile, sessionMap)
  }

  // --- Message history ---

  async getRecentMessages(
    windowId: string,
    opts: { startByte?: number; endByte?: number | null } = {},
  ): Promise<[Array<Record<string, unknown>>, number]> {
    const session = await this.resolveSessionForWindow(windowId)
    if (!session?.filePath) return [[], 0]
    if (!existsSync(session.filePath)) return [[], 0]

    const { startByte = 0, endByte = null } = opts
    const entries: Record<string, unknown>[] = []

    try {
      const file = Bun.file(session.filePath)
      const text = await file.text()
      const lines = text.split("\n")

      // Handle byte offsets by approximation (read whole file then filter)
      let byteOffset = 0
      for (const line of lines) {
        const lineBytes = Buffer.byteLength(line + "\n", "utf-8")
        if (byteOffset < startByte) {
          byteOffset += lineBytes
          continue
        }
        if (endByte != null && byteOffset >= endByte) break

        const trimmed = line.trim()
        if (!trimmed) { byteOffset += lineBytes; continue }
        try {
          const data = JSON.parse(trimmed)
          if (data) entries.push(data)
        }
        catch {}
        byteOffset += lineBytes
      }
    }
    catch {
      return [[], 0]
    }

    const [parsed] = TranscriptParser.parseEntries(entries as Array<Record<string, any>>)
    const messages = parsed.map(e => ({
      role: e.role,
      text: e.text,
      content_type: e.contentType,
      timestamp: e.timestamp,
    }))

    return [messages, messages.length]
  }

  // --- Tmux helpers ---

  async sendToWindow(windowId: string, text: string): Promise<[boolean, string]> {
    const window = await tmuxManager.findWindowById(windowId)
    if (!window) return [false, "Window not found"]
    const success = await tmuxManager.sendKeys(window.windowId, text)
    if (success) return [true, `Sent to ${this.getDisplayName(windowId)}`]
    return [false, "Failed to send keys"]
  }
}

export const sessionManager = new SessionManager()
