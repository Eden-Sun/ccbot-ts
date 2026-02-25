export interface TmuxWindow {
  windowId: string
  windowName: string
  cwd: string
  paneCurrentCommand?: string
}

export interface WindowState {
  sessionId: string
  cwd: string
  windowName: string
}

export interface ClaudeSession {
  sessionId: string
  summary: string
  messageCount: number
  filePath: string
}

export interface ParsedMessage {
  messageType: string
  text: string
  toolName?: string
}

export interface ParsedEntry {
  role: string
  text: string
  contentType: string
  toolUseId?: string
  timestamp?: string
  toolName?: string
  imageData?: Array<[string, Uint8Array]>
}

export interface PendingToolInfo {
  summary: string
  toolName: string
  inputData?: any
}

export interface TrackedSession {
  sessionId: string
  filePath: string
  lastByteOffset: number
}

export interface SessionInfo {
  sessionId: string
  filePath: string
}

export interface NewMessage {
  sessionId: string
  text: string
  isComplete: boolean
  contentType: string
  toolUseId?: string
  role: string
  toolName?: string
  imageData?: Array<[string, Uint8Array]>
}

export interface InteractiveUIContent {
  content: string
  name: string
}

export interface UsageInfo {
  rawText: string
  parsedLines: string[]
}

export interface MessageTask {
  taskType: "content" | "status_update" | "status_clear"
  text?: string
  windowId?: string
  parts: string[]
  toolUseId?: string
  contentType: string
  threadId?: number
  imageData?: Array<[string, Uint8Array]>
}
