import { test, describe } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { OvernightGuard } from '../src/guard.js'
import { validateConfig, resolvePaths } from '../src/config.js'

// Fake timers that don't keep the process alive
const fakeTimers = {
  setTimeout: (cb, ms) => ({ unref: () => {}, callback: cb, ms }),
  clearTimeout: () => {},
  setInterval: (cb, ms) => ({ unref: () => {}, callback: cb, ms }),
  clearInterval: () => {},
}

function tempDir() {
  const dir = join(tmpdir(), `dsh-overnight-guard-manual-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
}

describe('manual test simulation', () => {
  test('simulated stall and recovery', () => {
    const dir = tempDir()
    const config = validateConfig({
      stallSeconds: 1,
      maxRecoveryWindowMinutes: 1,
      maxErrorRetries: 3,
      maxRequests: 10,
      maxHours: 1,
      maxBaht: 10,
      stopFile: 'STOP',
      logFile: 'night-guard.log.jsonl',
      statusFile: 'night-status.json',
    })
    const paths = resolvePaths(config, dir)

    const agent = {
      session: { id: 'test-session' },
      messages: [],
      cancelled: false,
      followup(msg) { this.messages.push(msg) },
      cancel() { this.cancelled = true },
    }

    const ctx = {
      on: () => () => {},
      logger: () => ({ info: () => {}, error: () => {} }),
    }

    const guard = new OvernightGuard({ config, paths, agent, ctx, onHalt: () => {}, ...fakeTimers })
    guard.start()
    // Simulate turn start to enter running state
    guard.onTurnStart({ turn: 1, step: 1 })

    // Simulate stall
    guard.onStallDetected('timeout')
    assert.strictEqual(guard.state, 'recovering')
    assert.ok(agent.cancelled)
    assert.ok(agent.messages.length > 0)

    // Check log
    const logContent = readFileSync(paths.logFile, 'utf8')
    assert.ok(logContent.includes('stall_detected'))
    assert.ok(logContent.includes('nudge_sent'))

    // Check status (force update first)
    guard.logger.updateStatus()
    const status = JSON.parse(readFileSync(paths.statusFile, 'utf8'))
    assert.strictEqual(status.state, 'recovering')

    guard.stop()
    cleanup(dir)
  })

  test('simulated provider error with backoff', () => {
    const dir = tempDir()
    const config = validateConfig({
      stallSeconds: 1,
      maxRecoveryWindowMinutes: 1,
      maxErrorRetries: 3,
      maxRequests: 10,
      maxHours: 1,
      maxBaht: 10,
      stopFile: 'STOP',
      logFile: 'night-guard.log.jsonl',
      statusFile: 'night-status.json',
    })
    const paths = resolvePaths(config, dir)

    const agent = {
      session: { id: 'test-session' },
      messages: [],
      cancelled: false,
      followup(msg) { this.messages.push(msg) },
      cancel() { this.cancelled = true },
    }

    const ctx = {
      on: () => () => {},
      logger: () => ({ info: () => {}, error: () => {} }),
    }

    const guard = new OvernightGuard({ config, paths, agent, ctx, onHalt: () => {}, ...fakeTimers })
    guard.start()

    // Simulate provider errors
    const payload = {
      turn: 1,
      step: 1,
      provider: 'mock',
      failure: { message: '503 Service Unavailable', code: 'service_unavailable' },
    }

    const result1 = guard.onRequestError(payload, () => {})
    assert.strictEqual(result1.kind, 'retry')
    assert.strictEqual(guard.errorBackoff.retryCount, 1)

    const result2 = guard.onRequestError(payload, () => {})
    assert.strictEqual(result2.kind, 'retry')
    assert.strictEqual(guard.errorBackoff.retryCount, 2)

    const result3 = guard.onRequestError(payload, () => {})
    assert.strictEqual(result3.kind, 'retry')
    assert.strictEqual(guard.errorBackoff.retryCount, 3)

    // Max retries reached
    const result4 = guard.onRequestError(payload, () => {})
    assert.strictEqual(result4, undefined) // next() was called
    assert.strictEqual(guard.state, 'blocked')

    guard.stop()
    cleanup(dir)
  })

  test('simulated empty reply', () => {
    const dir = tempDir()
    const config = validateConfig({
      stallSeconds: 1,
      maxRecoveryWindowMinutes: 1,
      maxErrorRetries: 3,
      maxRequests: 10,
      maxHours: 1,
      maxBaht: 10,
      stopFile: 'STOP',
      logFile: 'night-guard.log.jsonl',
      statusFile: 'night-status.json',
    })
    const paths = resolvePaths(config, dir)

    const agent = {
      session: { id: 'test-session' },
      messages: [],
      cancelled: false,
      followup(msg) { this.messages.push(msg) },
      cancel() { this.cancelled = true },
    }

    const ctx = {
      on: () => () => {},
      logger: () => ({ info: () => {}, error: () => {} }),
    }

    const guard = new OvernightGuard({ config, paths, agent, ctx, onHalt: () => {}, ...fakeTimers })
    guard.start()
    guard.onTurnStart({ turn: 1, step: 1 })

    // Simulate empty reply
    guard.onAssistantMessage({
      message: { content: [{ type: 'text', text: '' }] },
      turn: 1,
      step: 1,
    })

    assert.strictEqual(guard.state, 'recovering')

    const logContent = readFileSync(paths.logFile, 'utf8')
    assert.ok(logContent.includes('empty_reply_detected'))

    guard.stop()
    cleanup(dir)
  })

  test('simulated tool call as text', () => {
    const dir = tempDir()
    const config = validateConfig({
      stallSeconds: 1,
      maxRecoveryWindowMinutes: 1,
      maxErrorRetries: 3,
      maxRequests: 10,
      maxHours: 1,
      maxBaht: 10,
      stopFile: 'STOP',
      logFile: 'night-guard.log.jsonl',
      statusFile: 'night-status.json',
    })
    const paths = resolvePaths(config, dir)

    const agent = {
      session: { id: 'test-session' },
      messages: [],
      cancelled: false,
      followup(msg) { this.messages.push(msg) },
      cancel() { this.cancelled = true },
    }

    const ctx = {
      on: () => () => {},
      logger: () => ({ info: () => {}, error: () => {} }),
    }

    const guard = new OvernightGuard({ config, paths, agent, ctx, onHalt: () => {}, ...fakeTimers })
    guard.start()
    guard.onTurnStart({ turn: 1, step: 1 })

    // Simulate tool call as text
    guard.onAssistantMessage({
      message: { content: [{ type: 'text', text: 'bash -c "ls -la"' }] },
      turn: 1,
      step: 1,
    })

    assert.strictEqual(guard.state, 'recovering')

    const logContent = readFileSync(paths.logFile, 'utf8')
    assert.ok(logContent.includes('tool_call_as_text_detected'))

    guard.stop()
    cleanup(dir)
  })
})
