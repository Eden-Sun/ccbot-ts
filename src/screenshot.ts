/**
 * Terminal text screenshot renderer.
 *
 * Simplified port of screenshot.py. Since Bun/Node lacks PIL/Pillow,
 * this renders the captured pane text as UTF-8 bytes (plain text).
 * The bot sends the result as a .txt document.
 *
 * ANSI escape sequences are stripped for readability.
 */

// Strip ANSI color/control sequences
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b[@-Z\\-_]|[\x80-\x9f]/g

/**
 * Convert terminal pane text to displayable bytes.
 *
 * @param text Captured tmux pane text (may contain ANSI codes if withAnsi=true)
 * @param withAnsi Whether the input contains ANSI escape codes
 * @returns UTF-8 encoded bytes of the cleaned text
 */
export async function textToImage(text: string, withAnsi = false): Promise<Uint8Array> {
  let clean = text
  if (withAnsi) {
    clean = text.replace(ANSI_RE, "")
  }
  // Normalize trailing whitespace per line
  clean = clean
    .split("\n")
    .map(line => line.trimEnd())
    .join("\n")
    .trimEnd()

  return new TextEncoder().encode(clean)
}
