/**
 * Detect whether a text block looks like a tool call printed as plain text.
 * Matches patterns like:
 * - `bash -c "..."` or `bash -c '...'`
 * - `npm install ...`
 * - `node script.js`
 * - `python script.py`
 * - `git commit ...`
 * - `curl ...`
 * - `{"name": "tool_name", "arguments": {...}}`
 * - `<tool_call>...</tool_call>`
 * - `functions.tool_name(...)`
 */
export function isToolCallAsText(text) {
  if (typeof text !== 'string' || text.length === 0) return false

  const trimmed = text.trim()

  // JSON-style tool call
  if (/^\{\s*"name"\s*:\s*"[a-zA-Z_]+"\s*,\s*"arguments"\s*:/.test(trimmed)) return true
  if (/^\{\s*"tool"\s*:\s*"[a-zA-Z_]+"\s*,/.test(trimmed)) return true

  // XML-style tool call
  if (/^<tool_call>/.test(trimmed)) return true
  if (/^<function=/.test(trimmed)) return true

  // Shell command patterns (common prefixes)
  const shellPatterns = [
    /^bash\s+-c\s+["']/,
    /^sh\s+-c\s+["']/,
    /^zsh\s+-c\s+["']/,
    /^npm\s+(install|run|test|build|start)/,
    /^pnpm\s+(install|run|test|build)/,
    /^yarn\s+(install|run|test|build)/,
    /^node\s+[\w./-]+\.js/,
    /^python\s+[\w./-]+\.py/,
    /^python3\s+[\w./-]+\.py/,
    /^git\s+(add|commit|push|pull|checkout|merge|status|diff|log)/,
    /^curl\s+/,
    /^wget\s+/,
    /^cd\s+[\w./-]+/,
    /^ls\s+/,
    /^cat\s+[\w./-]+/,
    /^mkdir\s+/,
    /^rm\s+/,
    /^cp\s+/,
    /^mv\s+/,
    /^echo\s+/,
    /^export\s+[A-Z_]+=/,
    /^docker\s+/,
    /^docker-compose\s+/,
  ]
  for (const pattern of shellPatterns) {
    if (pattern.test(trimmed)) return true
  }

  // Function call pattern: functions.name(...)
  if (/^functions\.[a-zA-Z_]+\s*\(/.test(trimmed)) return true

  return false
}

/**
 * Detect whether an assistant message is effectively empty.
 */
export function isEmptyReply(message) {
  if (!message || !message.content) return true
  if (!Array.isArray(message.content)) return true
  if (message.content.length === 0) return true

  // Check if all blocks are empty text
  const hasContent = message.content.some(block => {
    if (block.type === 'text') {
      return typeof block.text === 'string' && block.text.trim().length > 0
    }
    if (block.type === 'tool-call') return true
    return false
  })
  return !hasContent
}

/**
 * Detect whether the assistant is repeating itself.
 * Compares the last N messages for identical content or identical tool calls.
 */
export class LoopDetector {
  constructor(windowSize = 3) {
    this.windowSize = windowSize
    this.history = []
  }

  addMessage(message) {
    if (!message || !message.content) return false

    const signature = this.signatureOf(message)
    this.history.push(signature)
    if (this.history.length > this.windowSize) {
      this.history.shift()
    }

    // Check if all entries in history are identical
    if (this.history.length === this.windowSize) {
      const first = this.history[0]
      return this.history.every(s => s === first)
    }
    return false
  }

  signatureOf(message) {
    const parts = []
    for (const block of message.content) {
      if (block.type === 'text') {
        parts.push(`text:${block.text}`)
      } else if (block.type === 'tool-call') {
        parts.push(`tool:${block.name}:${JSON.stringify(block.arguments)}`)
      }
    }
    return parts.join('|')
  }

  reset() {
    this.history = []
  }
}
