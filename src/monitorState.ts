/**
 * Monitor state persistence — tracks byte offsets for each session.
 */

import { existsSync } from "fs"
import { atomicWriteJson } from "./utils"
import type { TrackedSession } from "./types"

export class MonitorState {
  stateFile: string
  trackedSessions: Map<string, TrackedSession> = new Map()
  private _dirty = false

  constructor(stateFile: string) {
    this.stateFile = stateFile
  }

  load(): void {
    if (!existsSync(this.stateFile)) return
    try {
      const data = JSON.parse(require("fs").readFileSync(this.stateFile, "utf-8"))
      const sessions = data.tracked_sessions ?? {}
      this.trackedSessions = new Map()
      for (const [k, v] of Object.entries(sessions)) {
        const d = v as Record<string, unknown>
        this.trackedSessions.set(k, {
          sessionId: d.session_id as string ?? "",
          filePath: d.file_path as string ?? "",
          lastByteOffset: d.last_byte_offset as number ?? 0,
        })
      }
    }
    catch {
      this.trackedSessions = new Map()
    }
  }

  save(): void {
    const tracked: Record<string, unknown> = {}
    for (const [k, v] of this.trackedSessions) {
      tracked[k] = {
        session_id: v.sessionId,
        file_path: v.filePath,
        last_byte_offset: v.lastByteOffset,
      }
    }
    atomicWriteJson(this.stateFile, { tracked_sessions: tracked })
    this._dirty = false
  }

  saveIfDirty(): void {
    if (this._dirty) this.save()
  }

  getSession(sessionId: string): TrackedSession | null {
    return this.trackedSessions.get(sessionId) ?? null
  }

  updateSession(session: TrackedSession): void {
    this.trackedSessions.set(session.sessionId, session)
    this._dirty = true
  }

  removeSession(sessionId: string): void {
    if (this.trackedSessions.has(sessionId)) {
      this.trackedSessions.delete(sessionId)
      this._dirty = true
    }
  }
}
