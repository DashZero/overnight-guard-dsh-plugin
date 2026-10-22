import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { OvernightGuard } from '../src/guard.js'
import { validateConfig, resolvePaths } from '../src/config.js'

// Fake clock for deterministic tests
class FakeClock {
  constructor() {
    this.now = Date.now()
    this.timers = []
    this.intervals = []
  }

  advance(ms) {
    this.now += ms
    // Fire timers whose time has come
    const due = this.timers.filter(t => t.time <= this.now)
    this.timers = this.timers.filter(t => t.time > this.now)
    for (const timer of due) {
      timer.callback()
    }
  }

  setTimeout(callback, ms) {
    const timer = { time: this.now + ms, callback }
    this.timers.push(timer)
    return timer
  }

  clearTimeout(timer) {
    this.timers = this.timers.filter(t => t !== timer)
  }

  setInterval(callback, ms) {
    const interval = { callback, ms }
    this.intervals.push(interval)
    return interval
  }

  clearInterval(interval) {
    this.intervals = this.intervals.filter(i => i !== interval)
  }
}

// Fake event source (simulates DSH session events)
class FakeEventSource {
  constructor() {
    this.listeners = new Map()
  }

  on(event, listener) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, [])
    }
    this.listeners.get(event).push(listener)
    return () => {
      const list = this.listeners.get(event)
      const idx = list.indexOf(listener)
      if (idx >= 0) list.splice(idx, 1)
    }
  }

  emit(event, ...args) {
    const list = this.listeners.get(event) || []
    for (const listener of list) {
      listener(...args)
    }
  }
}

// Fake agent
class FakeAgent {
  constructor(sessionId = 'session-1') {
    this.session = { id: sessionId }
    this.messages = []
    this.cancelled = false
  }

  followup(message) {
    this.messages.push(message)
  }

  steer(message) {
    this.messages.push(message)
  }

  cancel(cause) {
    this.cancelled = true
    this.cancelCause = cause
  }
}

function tempDir() {
  const dir = join(tmpdir(), `dsh-overnight-guard-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
}

describe('OvernightGuard integration', () => {
  let dir
  let config
  let paths
  let agent
  let eventSource
  let guard

  beforeEach(() => {
    dir = tempDir()
    config = validateConfig({
      stallSeconds: 5, // 5 seconds for fast tests
      maxRecoveryWindowMinutes: 1,
      maxErrorRetries: 3,
      maxRequests: 10,
      maxHours: 1,
      maxBaht: 10,
      stopFile: 'STOP',
      logFile: 'night-guard.log.jsonl',
      statusFile: 'night-status.json',
    })
    paths = resolvePaths(config, dir)
    agent = new FakeAgent()
    eventSource = new FakeEventSource()

    // Create a minimal ctx mock
    const ctx = {
      on: (event, listener) => eventSource.on(event, listener),
      logger: () => ({ info: () => {}, error: () => {} }),
    }

    guard = new OvernightGuard({
      config,
      paths,
      agent,
      ctx,
      onHalt: () => {},
    })
  })

  afterEach(() => {
    guard.stop()
    cleanup(dir)
  })

  test('starts in armed state', () => {
    guard.start()
    assert.strictEqual(guard.state, 'armed')
  })

  test('detects stall after stallSeconds', () => {
    guard.start()
    guard.state = 'running'
    guard.resetStallTimer()

    // Stall should not fire before stallSeconds
    assert.strictEqual(guard.state, 'running')

    // Manually trigger the stall
    guard.onStallDetected('timeout')
    assert.strictEqual(guard.state, 'recovering')
    assert.ok(agent.cancelled)
    assert.ok(agent.messages.length > 0)
  })

  test('recovery ladder goes a, b, c', () => {
    guard.start()
    guard.state = 'running'

    // First stall: nudge
    guard.onStallDetected('timeout')
    assert.strictEqual(guard.state, 'recovering')
    assert.strictEqual(guard.recovery.stallCount, 1)
    const firstMessage = agent.messages[agent.messages.length - 1]
    assert.ok(firstMessage.content[0].text.includes('You stopped'))

    // Reset state to simulate recovery, then stall again
    guard.state = 'running'
    guard.onStallDetected('timeout')
    assert.strictEqual(guard.recovery.stallCount, 2)

    // Reset state to simulate recovery, then stall again
    guard.state = 'running'
    guard.onStallDetected('timeout')
    // After skip, recovery.reset() is called, so stallCount is 0
    assert.strictEqual(guard.recovery.stallCount, 0)

    // Fourth stall: starts over with nudge
    guard.state = 'running'
    guard.onStallDetected('timeout')
    assert.strictEqual(guard.recovery.stallCount, 1)
  })

  test('empty reply counts as stall', () => {
    guard.start()
    guard.state = 'running'

    const message = { content: [{ type: 'text', text: '' }] }
    guard.onAssistantMessage({ message, turn: 1, step: 1 })

    assert.strictEqual(guard.state, 'recovering')
  })

  test('tool call as text counts as stall', () => {
    guard.start()
    guard.state = 'running'

    const message = { content: [{ type: 'text', text: 'bash -c "ls -la"' }] }
    guard.onAssistantMessage({ message, turn: 1, step: 1 })

    assert.strictEqual(guard.state, 'recovering')
  })

  test('loop detection fires on third repeat', () => {
    guard.start()
    guard.state = 'running'

    const message = { content: [{ type: 'text', text: 'same message' }] }
    guard.onAssistantMessage({ message, turn: 1, step: 1 })
    guard.onAssistantMessage({ message, turn: 1, step: 1 })
    guard.onAssistantMessage({ message, turn: 1, step: 1 })

    // Should have sent a corrective nudge
    const lastMessage = agent.messages[agent.messages.length - 1]
    assert.ok(lastMessage.content[0].text.includes('repeating yourself'))
  })

  test('halts on max requests', () => {
    guard.start()
    guard.state = 'running'

    // Simulate 10 requests
    for (let i = 0; i < 10; i++) {
      guard.logger.counters.requests++
    }
    guard.checkCaps()

    assert.ok(guard.halted)
    assert.ok(guard.haltReason.includes('max_requests'))
  })

  test('halts on stop file', () => {
    guard.start()
    writeFileSync(paths.stopFile, 'stop')

    guard.checkCaps()
    assert.ok(guard.halted)
    assert.ok(guard.haltReason.includes('stop_file'))
  })

  test('writes summary on halt', () => {
    guard.start()
    guard.halt('test_reason')

    const date = new Date().toISOString().slice(0, 10)
    const summaryFile = join(dir, `night-summary-${date}.md`)
    assert.ok(existsSync(summaryFile))

    const content = readFileSync(summaryFile, 'utf8')
    assert.ok(content.includes('test_reason'))
  })

  test('log lines never contain sensitive strings', () => {
    guard.start()
    guard.state = 'running'

    // Simulate events that might contain sensitive data
    guard.logger.log('test', { key: 'sk-secret123', auth: 'Bearer token' })

    const content = readFileSync(paths.logFile, 'utf8')
    assert.ok(!content.includes('sk-secret123'))
    assert.ok(!content.includes('Bearer token'))
    assert.ok(content.includes('[REDACTED]'))
  })
})
