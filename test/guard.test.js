import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { validateConfig, resolvePaths } from '../src/config.js'
import { GuardLogger } from '../src/logger.js'
import { isToolCallAsText, isEmptyReply, LoopDetector } from '../src/detectors.js'
import { RecoveryLadder, ErrorBackoff } from '../src/recovery.js'
import { checkCaps } from '../src/caps.js'

// Helper: create a temp directory for each test
function tempDir() {
  const dir = join(tmpdir(), `dsh-overnight-guard-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

// Helper: cleanup temp directory
function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
}

describe('config validation', () => {
  test('accepts valid config', () => {
    const config = validateConfig({})
    assert.strictEqual(config.stallSeconds, 300)
    assert.strictEqual(config.maxRequests, 300)
  })

  test('rejects bad stallSeconds', () => {
    assert.throws(() => validateConfig({ stallSeconds: 0 }), /stallSeconds/)
    assert.throws(() => validateConfig({ stallSeconds: -1 }), /stallSeconds/)
    assert.throws(() => validateConfig({ stallSeconds: 'abc' }), /stallSeconds/)
  })

  test('rejects bad maxRequests', () => {
    assert.throws(() => validateConfig({ maxRequests: 0 }), /maxRequests/)
    assert.throws(() => validateConfig({ maxRequests: -1 }), /maxRequests/)
  })

  test('rejects bad maxBaht', () => {
    assert.throws(() => validateConfig({ maxBaht: -1 }), /maxBaht/)
  })

  test('rejects empty strings', () => {
    assert.throws(() => validateConfig({ nudgeText: '' }), /nudgeText/)
    assert.throws(() => validateConfig({ stopFile: '' }), /stopFile/)
  })

  test('rejects path traversal', () => {
    assert.throws(() => validateConfig({ logFile: '../evil.log' }), /\.\./)
  })

  test('resolves paths with Windows-style separators', () => {
    const config = validateConfig({})
    const paths = resolvePaths(config, 'C:\\Users\\test')
    assert.ok(paths.logFile.includes('night-guard.log.jsonl'))
    assert.ok(paths.stopFile.includes('STOP'))
  })
})

describe('detectors', () => {
  test('detects tool call as text', () => {
    assert.ok(isToolCallAsText('bash -c "ls -la"'))
    assert.ok(isToolCallAsText('npm install foo'))
    assert.ok(isToolCallAsText('node script.js'))
    assert.ok(isToolCallAsText('git commit -m "msg"'))
    assert.ok(isToolCallAsText('curl https://example.com'))
    assert.ok(isToolCallAsText('{"name": "bash", "arguments": {"command": "ls"}}'))
    assert.ok(isToolCallAsText('<tool_call>bash</tool_call>'))
    assert.ok(isToolCallAsText('functions.bash("ls")'))
  })

  test('does not flag normal text', () => {
    assert.ok(!isToolCallAsText('I will now run the tests'))
    assert.ok(!isToolCallAsText('The command failed with error'))
    assert.ok(!isToolCallAsText('Let me check the file'))
    assert.ok(!isToolCallAsText(''))
  })

  test('detects empty reply', () => {
    assert.ok(isEmptyReply(null))
    assert.ok(isEmptyReply({}))
    assert.ok(isEmptyReply({ content: [] }))
    assert.ok(isEmptyReply({ content: [{ type: 'text', text: '' }] }))
    assert.ok(isEmptyReply({ content: [{ type: 'text', text: '   ' }] }))
    assert.ok(!isEmptyReply({ content: [{ type: 'text', text: 'Hello' }] }))
    assert.ok(!isEmptyReply({ content: [{ type: 'tool-call', name: 'bash', arguments: {} }] }))
  })

  test('loop detector fires on third repeat', () => {
    const detector = new LoopDetector(3)
    const msg = { content: [{ type: 'text', text: 'same message' }] }

    assert.ok(!detector.addMessage(msg))
    assert.ok(!detector.addMessage(msg))
    assert.ok(detector.addMessage(msg)) // Third repeat
  })

  test('loop detector resets on different message', () => {
    const detector = new LoopDetector(3)
    const msg1 = { content: [{ type: 'text', text: 'message 1' }] }
    const msg2 = { content: [{ type: 'text', text: 'message 2' }] }

    detector.addMessage(msg1)
    detector.addMessage(msg1)
    detector.addMessage(msg2)
    detector.addMessage(msg1)
    detector.addMessage(msg1)
    // After msg2, the history is [msg2, msg1, msg1], so adding msg1 gives [msg1, msg1, msg1] which is a loop
    // Let's test with a cleaner sequence
    detector.reset()
    detector.addMessage(msg1)
    detector.addMessage(msg1)
    detector.addMessage(msg2) // breaks the loop
    detector.addMessage(msg1)
    detector.addMessage(msg1)
    assert.ok(!detector.addMessage(msg2)) // [msg1, msg1, msg2] - not a loop
  })

  test('loop detector detects same tool call', () => {
    const detector = new LoopDetector(3)
    const msg = { content: [{ type: 'tool-call', name: 'bash', arguments: { command: 'ls' } }] }

    assert.ok(!detector.addMessage(msg))
    assert.ok(!detector.addMessage(msg))
    assert.ok(detector.addMessage(msg))
  })
})

describe('recovery ladder', () => {
  test('goes a, b, c', () => {
    const ladder = new RecoveryLadder(30)

    const a = ladder.recordStall('nudge')
    assert.strictEqual(a.action, 'nudge')

    const b = ladder.recordStall('nudge')
    assert.strictEqual(b.action, 'nudge_with_log')

    const c = ladder.recordStall('nudge')
    assert.strictEqual(c.action, 'skip')

    const d = ladder.recordStall('nudge')
    assert.strictEqual(d.action, 'blocked')
  })

  test('resets on recovery', () => {
    const ladder = new RecoveryLadder(30)
    ladder.recordStall('nudge')
    ladder.recordStall('nudge')
    ladder.recordRecovery()
    const action = ladder.recordStall('nudge')
    assert.strictEqual(action.action, 'nudge')
  })
})

describe('error backoff', () => {
  test('uses 5, 10, 20, 40, 60 second backoff', () => {
    const backoff = new ErrorBackoff(8)
    assert.strictEqual(backoff.nextDelay(), 5000)
    assert.strictEqual(backoff.nextDelay(), 10000)
    assert.strictEqual(backoff.nextDelay(), 20000)
    assert.strictEqual(backoff.nextDelay(), 40000)
    assert.strictEqual(backoff.nextDelay(), 60000)
    assert.strictEqual(backoff.nextDelay(), 60000)
    assert.strictEqual(backoff.nextDelay(), 60000)
    assert.strictEqual(backoff.nextDelay(), 60000)
    assert.strictEqual(backoff.nextDelay(), null) // Max retries reached
  })

  test('resets', () => {
    const backoff = new ErrorBackoff(8)
    backoff.nextDelay()
    backoff.nextDelay()
    backoff.reset()
    assert.strictEqual(backoff.nextDelay(), 5000)
  })
})

describe('caps', () => {
  test('halts on max requests', () => {
    const result = checkCaps(
      { maxRequests: 10, maxHours: 10, maxBaht: 100, bahtPerRequest: 0.266, requests: 10 },
      {},
      new Date().toISOString(),
      '/nonexistent/STOP'
    )
    assert.ok(result.halted)
    assert.ok(result.reason.includes('max_requests'))
  })

  test('halts on max hours', () => {
    const tenHoursAgo = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString()
    const result = checkCaps(
      { maxRequests: 300, maxHours: 10, maxBaht: 100, bahtPerRequest: 0.266, requests: 0 },
      {},
      tenHoursAgo,
      '/nonexistent/STOP'
    )
    assert.ok(result.halted)
    assert.ok(result.reason.includes('max_hours'))
  })

  test('halts on max baht', () => {
    const result = checkCaps(
      { maxRequests: 300, maxHours: 10, maxBaht: 1, bahtPerRequest: 0.266, requests: 10 },
      {},
      new Date().toISOString(),
      '/nonexistent/STOP'
    )
    assert.ok(result.halted)
    assert.ok(result.reason.includes('max_baht'))
  })

  test('halts on stop file', () => {
    const dir = tempDir()
    const stopFile = join(dir, 'STOP')
    writeFileSync(stopFile, 'stop')

    const result = checkCaps(
      { maxRequests: 300, maxHours: 10, maxBaht: 100, bahtPerRequest: 0.266, requests: 0 },
      {},
      new Date().toISOString(),
      stopFile
    )
    assert.ok(result.halted)
    assert.ok(result.reason.includes('stop_file'))

    cleanup(dir)
  })

  test('does not halt when under caps', () => {
    const result = checkCaps(
      { maxRequests: 300, maxHours: 10, maxBaht: 100, bahtPerRequest: 0.266, requests: 5 },
      {},
      new Date().toISOString(),
      '/nonexistent/STOP'
    )
    assert.ok(!result.halted)
  })
})

describe('logger', () => {
  test('writes JSONL log lines', () => {
    const dir = tempDir()
    const logFile = join(dir, 'test.log.jsonl')
    const statusFile = join(dir, 'status.json')
    const nightLogFile = join(dir, 'NIGHT_LOG.md')

    const logger = new GuardLogger(logFile, statusFile, nightLogFile)
    logger.log('test_event', { detail: 'value' })

    const content = readFileSync(logFile, 'utf8')
    const line = JSON.parse(content.trim())
    assert.strictEqual(line.event, 'test_event')
    assert.strictEqual(line.detail, 'value')
    assert.strictEqual(line.counters.requests, 0)

    cleanup(dir)
  })

  test('never logs sensitive strings', () => {
    const dir = tempDir()
    const logFile = join(dir, 'test.log.jsonl')
    const statusFile = join(dir, 'status.json')
    const nightLogFile = join(dir, 'NIGHT_LOG.md')

    const logger = new GuardLogger(logFile, statusFile, nightLogFile)
    logger.log('test', { key: 'sk-1234567890', auth: 'Bearer token123', header: 'Authorization: Bearer x' })

    const content = readFileSync(logFile, 'utf8')
    assert.ok(!content.includes('sk-1234567890'))
    assert.ok(!content.includes('Bearer token123'))
    assert.ok(!content.includes('Authorization: Bearer x'))
    assert.ok(content.includes('[REDACTED]'))

    cleanup(dir)
  })

  test('updates status file', () => {
    const dir = tempDir()
    const logFile = join(dir, 'test.log.jsonl')
    const statusFile = join(dir, 'status.json')
    const nightLogFile = join(dir, 'NIGHT_LOG.md')

    const logger = new GuardLogger(logFile, statusFile, nightLogFile)
    logger.state = 'running'
    logger.currentStep = 5
    logger.counters.requests = 10
    logger.updateStatus()

    const status = JSON.parse(readFileSync(statusFile, 'utf8'))
    assert.strictEqual(status.state, 'running')
    assert.strictEqual(status.currentStep, 5)
    assert.strictEqual(status.requests, 10)
    assert.strictEqual(status.estimatedBaht, 2.66)

    cleanup(dir)
  })

  test('appends to NIGHT_LOG.md between markers only', () => {
    const dir = tempDir()
    const logFile = join(dir, 'test.log.jsonl')
    const statusFile = join(dir, 'status.json')
    const nightLogFile = join(dir, 'NIGHT_LOG.md')

    // Create a NIGHT_LOG.md with existing content
    writeFileSync(nightLogFile, '# Night Log\n\nSome existing content.\n\n<!-- night-guard:start -->\n| Step | Status | Time | Requests | Notes |\n|------|--------|------|----------|-------|\n<!-- night-guard:end -->\n\nMore content after.\n')

    const logger = new GuardLogger(logFile, statusFile, nightLogFile)
    logger.appendNightLog(1, 'done', 'test note')

    const content = readFileSync(nightLogFile, 'utf8')
    assert.ok(content.includes('Some existing content.'))
    assert.ok(content.includes('More content after.'))
    assert.ok(content.includes('| 1 | done |'))
    assert.ok(content.includes('test note'))

    // Verify only the marked block was changed
    const beforeMarker = content.split('<!-- night-guard:start -->')[0]
    const afterMarker = content.split('<!-- night-guard:end -->')[1]
    assert.ok(beforeMarker.includes('Some existing content.'))
    assert.ok(afterMarker.includes('More content after.'))

    cleanup(dir)
  })

  test('creates markers if missing', () => {
    const dir = tempDir()
    const logFile = join(dir, 'test.log.jsonl')
    const statusFile = join(dir, 'status.json')
    const nightLogFile = join(dir, 'NIGHT_LOG.md')

    writeFileSync(nightLogFile, '# Night Log\n\nNo markers here.\n')

    const logger = new GuardLogger(logFile, statusFile, nightLogFile)
    logger.appendNightLog(1, 'done', 'test')

    const content = readFileSync(nightLogFile, 'utf8')
    assert.ok(content.includes('<!-- night-guard:start -->'))
    assert.ok(content.includes('<!-- night-guard:end -->'))
    assert.ok(content.includes('| 1 | done |'))

    cleanup(dir)
  })

  test('writes summary file', () => {
    const dir = tempDir()
    const logFile = join(dir, 'night-guard.log.jsonl')
    const statusFile = join(dir, 'status.json')
    const nightLogFile = join(dir, 'NIGHT_LOG.md')

    const logger = new GuardLogger(logFile, statusFile, nightLogFile)
    logger.counters.requests = 50
    logger.counters.recoveries = 3
    logger.counters.blocked = 1
    logger.blockedSteps = [2]
    logger.firstError = '503 Service Unavailable'

    const summaryFile = logger.writeSummary('max_requests_reached')
    assert.ok(existsSync(summaryFile))

    const content = readFileSync(summaryFile, 'utf8')
    assert.ok(content.includes('max_requests_reached'))
    assert.ok(content.includes('50'))
    assert.ok(content.includes('13.3'))
    assert.ok(content.includes('503'))

    cleanup(dir)
  })
})
