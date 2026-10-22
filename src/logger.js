import { appendFileSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SENSITIVE_PATTERNS = [
  /sk-[a-zA-Z0-9]/,
  /ccsk-[a-zA-Z0-9]/,
  /Authorization/i,
  /Bearer\s+[a-zA-Z0-9]/,
]

function sanitize(text) {
  if (typeof text !== 'string') return text
  let result = text
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]')
  }
  return result
}

export class GuardLogger {
  constructor(logFile, statusFile, nightLogFile) {
    this.logFile = logFile
    this.statusFile = statusFile
    this.nightLogFile = nightLogFile
    this.counters = {
      requests: 0,
      recoveries: 0,
      blocked: 0,
      errors: 0,
    }
    this.currentStep = 0
    this.state = 'idle'
    this.startedAt = new Date().toISOString()
    this.blockedSteps = []
    this.firstError = null

    // Ensure directories exist
    for (const file of [logFile, statusFile, nightLogFile]) {
      mkdirSync(dirname(file), { recursive: true })
    }
  }

  log(eventType, data = {}) {
    const line = {
      time: new Date().toISOString(),
      step: this.currentStep,
      event: eventType,
      counters: { ...this.counters },
      ...data,
    }
    // Sanitize all string values
    const sanitized = JSON.parse(JSON.stringify(line, (key, value) => {
      if (typeof value === 'string') return sanitize(value)
      return value
    }))
    appendFileSync(this.logFile, JSON.stringify(sanitized) + '\n')
  }

  updateStatus() {
    const status = {
      state: this.state,
      currentStep: this.currentStep,
      requests: this.counters.requests,
      estimatedBaht: Math.round(this.counters.requests * 0.266 * 100) / 100,
      recoveries: this.counters.recoveries,
      blockedSteps: this.blockedSteps,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
    }
    writeFileSync(this.statusFile, JSON.stringify(status, null, 2) + '\n')
  }

  appendNightLog(step, status, notes = '') {
    const startMarker = '<!-- night-guard:start -->'
    const endMarker = '<!-- night-guard:end -->'
    const row = `| ${step} | ${status} | ${new Date().toISOString()} | ${this.counters.requests} | ${sanitize(notes)} |\n`

    let content = ''
    if (existsSync(this.nightLogFile)) {
      content = readFileSync(this.nightLogFile, 'utf8')
    }

    if (!content.includes(startMarker)) {
      content += `\n${startMarker}\n| Step | Status | Time | Requests | Notes |\n|------|--------|------|----------|-------|\n${endMarker}\n`
    }

    const startIdx = content.indexOf(startMarker) + startMarker.length
    const endIdx = content.indexOf(endMarker)
    const before = content.slice(0, startIdx)
    const after = content.slice(endIdx)
    const block = content.slice(startIdx, endIdx)

    // Ensure header exists
    let newBlock = block
    if (!block.includes('| Step |')) {
      newBlock = '\n| Step | Status | Time | Requests | Notes |\n|------|--------|------|----------|-------|\n' + block
    }

    newBlock += row
    writeFileSync(this.nightLogFile, before + newBlock + after)
  }

  writeSummary(reason) {
    const date = new Date().toISOString().slice(0, 10)
    const summaryFile = join(dirname(this.logFile), `night-summary-${date}.md`)
    const lines = [
      `# Night Guard Summary — ${date}`,
      '',
      `- Stop reason: ${reason}`,
      `- Steps done: ${this.currentStep - this.blockedSteps.length}`,
      `- Steps blocked: ${this.blockedSteps.length}`,
      `- Blocked steps: ${this.blockedSteps.join(', ') || 'none'}`,
      `- Total requests: ${this.counters.requests}`,
      `- Estimated cost: ${Math.round(this.counters.requests * 0.266 * 100) / 100} baht`,
      `- Recoveries: ${this.counters.recoveries}`,
      `- Errors: ${this.counters.errors}`,
      `- First error: ${this.firstError || 'none'}`,
      `- Started: ${this.startedAt}`,
      `- Ended: ${new Date().toISOString()}`,
    ]
    writeFileSync(summaryFile, lines.join('\n') + '\n')
    return summaryFile
  }
}
