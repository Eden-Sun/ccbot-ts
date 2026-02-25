/**
 * Directory browser and window picker UI for session creation.
 *
 * Port of directory_browser.py. Provides UIs in Telegram for:
 *   - Window picker: list unbound tmux windows for quick binding
 *   - Directory browser: navigate directory hierarchies to create new sessions
 */

import { readdirSync, existsSync, statSync } from "fs"
import { resolve, join } from "path"
import { homedir } from "os"
import type { InlineKeyboardMarkup } from "@grammyjs/types"
import { config } from "../config"
import {
  CB_DIR_CANCEL,
  CB_DIR_CONFIRM,
  CB_DIR_PAGE,
  CB_DIR_SELECT,
  CB_DIR_UP,
  CB_WIN_BIND,
  CB_WIN_CANCEL,
  CB_WIN_NEW,
} from "./callbackData"

const DIRS_PER_PAGE = 6

// User state keys
export const STATE_KEY = "state"
export const STATE_BROWSING_DIRECTORY = "browsing_directory"
export const STATE_SELECTING_WINDOW = "selecting_window"
export const BROWSE_PATH_KEY = "browse_path"
export const BROWSE_PAGE_KEY = "browse_page"
export const BROWSE_DIRS_KEY = "browse_dirs"
export const UNBOUND_WINDOWS_KEY = "unbound_windows"

export function clearBrowseState(userData: Record<string, unknown> | null | undefined): void {
  if (!userData) return
  delete userData[STATE_KEY]
  delete userData[BROWSE_PATH_KEY]
  delete userData[BROWSE_PAGE_KEY]
  delete userData[BROWSE_DIRS_KEY]
}

export function clearWindowPickerState(userData: Record<string, unknown> | null | undefined): void {
  if (!userData) return
  delete userData[STATE_KEY]
  delete userData[UNBOUND_WINDOWS_KEY]
}

/** Build window picker UI for unbound tmux windows. */
export function buildWindowPicker(
  windows: Array<[string, string, string]>,
): [string, InlineKeyboardMarkup] {
  const home = homedir()
  const lines: string[] = [
    "*Bind to Existing Window*\n",
    "These windows are running but not bound to any topic.",
    "Pick one to attach it here, or start a new session.\n",
  ]
  for (const [, name, cwd] of windows) {
    const displayCwd = cwd.replace(home, "~")
    lines.push(`• \`${name}\` — ${displayCwd}`)
  }

  const buttons: Array<Array<{ text: string; callback_data: string }>> = []
  for (let i = 0; i < windows.length; i += 2) {
    const row: Array<{ text: string; callback_data: string }> = []
    for (let j = 0; j < 2 && i + j < windows.length; j++) {
      const win = windows[i + j]!
      const name = win[1]!
      const wid = win[0]!
      const display = name.length > 13 ? name.slice(0, 12) + "…" : name
      // Encode window ID directly — no cache needed, survives bot restarts
      row.push({
        text: `🖥 ${display}`,
        callback_data: (`${CB_WIN_BIND}${wid}`).slice(0, 64),
      })
    }
    buttons.push(row)
  }

  buttons.push([
    { text: "➕ New Session", callback_data: CB_WIN_NEW },
    { text: "Cancel", callback_data: CB_WIN_CANCEL },
  ])

  const text = lines.join("\n")
  return [text, { inline_keyboard: buttons }]
}

/** Build directory browser UI. Returns [text, keyboard, subdirs]. */
export function buildDirectoryBrowser(
  currentPath: string,
  page = 0,
): [string, InlineKeyboardMarkup, string[]] {
  let path = resolve(currentPath.replace(/^~/, homedir()))
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    path = process.cwd()
  }

  let subdirs: string[] = []
  try {
    subdirs = readdirSync(path)
      .filter(name => {
        try {
          const full = join(path, name)
          return statSync(full).isDirectory()
            && (config.showHiddenDirs || !name.startsWith("."))
        }
        catch {
          return false
        }
      })
      .sort()
  }
  catch {
    subdirs = []
  }

  const totalPages = Math.max(1, Math.ceil(subdirs.length / DIRS_PER_PAGE))
  page = Math.max(0, Math.min(page, totalPages - 1))
  const start = page * DIRS_PER_PAGE
  const pageDirs = subdirs.slice(start, start + DIRS_PER_PAGE)

  const buttons: Array<Array<{ text: string; callback_data: string }>> = []

  for (let i = 0; i < pageDirs.length; i += 2) {
    const row: Array<{ text: string; callback_data: string }> = []
    for (let j = 0; j < 2 && i + j < pageDirs.length; j++) {
      const name = pageDirs[i + j]!
      const display = name.length > 13 ? name.slice(0, 12) + "…" : name
      const idx = start + i + j
      row.push({
        text: `📁 ${display}`,
        callback_data: `${CB_DIR_SELECT}${idx}`,
      })
    }
    buttons.push(row)
  }

  if (totalPages > 1) {
    const nav: Array<{ text: string; callback_data: string }> = []
    if (page > 0) nav.push({ text: "◀", callback_data: `${CB_DIR_PAGE}${page - 1}` })
    nav.push({ text: `${page + 1}/${totalPages}`, callback_data: "noop" })
    if (page < totalPages - 1) nav.push({ text: "▶", callback_data: `${CB_DIR_PAGE}${page + 1}` })
    buttons.push(nav)
  }

  const actionRow: Array<{ text: string; callback_data: string }> = []
  const parentPath = resolve(join(path, ".."))
  if (parentPath !== path) {
    actionRow.push({ text: "..", callback_data: CB_DIR_UP })
  }
  actionRow.push({ text: "Select", callback_data: CB_DIR_CONFIRM })
  actionRow.push({ text: "Cancel", callback_data: CB_DIR_CANCEL })
  buttons.push(actionRow)

  const displayPath = path.replace(homedir(), "~")
  const text = subdirs.length === 0
    ? `*Select Working Directory*\n\nCurrent: \`${displayPath}\`\n\n_(No subdirectories)_`
    : `*Select Working Directory*\n\nCurrent: \`${displayPath}\`\n\nTap a folder to enter, or select current directory`

  return [text, { inline_keyboard: buttons }, subdirs]
}
