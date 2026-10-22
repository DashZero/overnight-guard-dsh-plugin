import { existsSync, readFileSync } from 'node:fs'
import { GuardLogger } from './logger.js'
import { isToolCallAsText, isEmptyReply, LoopDetector } from './detectors.js'
import { RecoveryLadder, ErrorBackoff } from './recovery.js'
import { checkCaps, watchStopFile } from './caps.js'

/**
 * The overnight guard state machine.
 * Observes a session, detects stalls, recovers, enforces caps.
 */
export class OvernightGuard {
  /**
   * @param {object} options
   * @param {object} options.config - validated config
   * @param {object} options.paths - resolved file paths
   * @param {object} options.agent - the DSH agent to guard
   * @param {object} options.ctx - the plugin's Cordis context
   * @param {() => void} options.onHalt - called when the guard halts
   */
  constructor(options) {
    this.config = options.config
    this.paths = options.paths
    this.agent = options.agent
    this.ctx = options.ctx
    this.onHalt = options.onHalt || (() => {})

    this.logger = new GuardLogger(this.paths.logFile, this.paths.statusFile, this.paths.nightLogFile)
    this.recovery = new RecoveryLadder(this.config.maxRecoveryWindowMinutes)
    this.errorBackoff = new ErrorBackoff(this.config.maxErrorRetries)
    this.loopDetector = new LoopDetector(3)

    this.state = 'idle'
    this.stallTimer = null
    this.statusTimer = null
    this.stopWatcher = null
    this.lastEventTime = Date.now()
    this.currentTurn = 0
    this.currentStep = 0
    this.halted = false
    this.haltReason = null
    this.pendingNudge = null
    this.loopCorrected = false

    this.disposers = []
  }

  start() {
    if (this.state !== 'idle') return
    this.state = 'armed'
    this.logger.state = 'armed'
    this.logger.log('guard_started')
    this.logger.updateStatus()

    // Watch stop file
    this.stopWatcher = watchStopFile(this.paths.stopFile, () => {
      this.halt('stop_file_found')
    })

    // Update status every 30 seconds
    this.statusTimer = setInterval(() => {
      this.logger.updateStatus()
    }, 30000)

    // Subscribe to session events
    this.disposers.push(
      this.ctx.on('session/event', (session, event) => this.onSessionEvent(session, event)),
      this.ctx.on('agent/assistant-stream', (payload) => this.onAssistantStream(payload)),
      this.ctx.on('agent/request-error', (payload, next) => this.onRequestError(payload, next)),
    )

    // Check caps immediately
    this.checkCaps()
  }

  stop() {
    this.clearTimers()
    if (this.stopWatcher) {
      this.stopWatcher()
      this.stopWatcher = null
    }
    for (const dispose of this.disposers) {
      dispose()
    }
    this.disposers = []
    this.state = 'idle'
  }

  clearStallTimer() {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer)
      this.stallTimer = null
    }
  }

  resetStallTimer() {
    this.clearStallTimer()
    this.lastEventTime = Date.now()
    this.stallTimer = setTimeout(() => {
      this.onStallDetected()
    }, this.config.stallSeconds * 1000)
  }

  clearTimers() {
    this.clearStallTimer()
    if (this.statusTimer) {
      clearInterval(this.statusTimer)
      this.statusTimer = null
    }
  }

  onSessionEvent(session, event) {
    if (this.halted) return
    if (session.id !== this.agent.session.id) return

    this.lastEventTime = Date.now()
    this.resetStallTimer()

    switch (event.type) {
      case 'turn/start':
        this.onTurnStart(event.data)
        break
      case 'turn/end':
        this.onTurnEnd(event.data)
        break
      case 'assistant/message':
        this.onAssistantMessage(event.data)
        break
      case 'tool/call':
        this.onToolCall(event.data)
        break
      case 'tool/result':
        this.onToolResult(event.data)
        break
    }

    this.checkCaps()
  }

  onAssistantStream(payload) {
    if (this.halted) return
    this.lastEventTime = Date.now()
    this.resetStallTimer()
  }

  onTurnStart(data) {
    this.currentTurn = data.turn
    this.currentStep = data.step
    this.state = 'running'
    this.logger.state = 'running'
    this.logger.currentStep = data.step
    this.logger.log('turn_start', { turn: data.turn, step: data.step })
    this.recovery.reset()
    this.loopDetector.reset()
    this.loopCorrected = false
  }

  onTurnEnd(data) {
    this.state = 'armed'
    this.logger.state = 'armed'
    this.logger.log('turn_end', { turn: data.turn, step: data.step, reason: data.reason?.kind })

    // Check for empty reply or tool-call-as-text
    if (data.reason?.kind === 'completed') {
      // The turn completed normally; check if we need to advance the step
      this.checkStepCompletion()
    }
  }

  onAssistantMessage(data) {
    const message = data.message
    this.logger.counters.requests++

    // Check for empty reply
    if (isEmptyReply(message)) {
      this.logger.log('empty_reply_detected')
      this.onStallDetected('empty_reply')
      return
    }

    // Check for tool-call-as-text
    const textBlocks = message.content.filter(b => b.type === 'text')
    for (const block of textBlocks) {
      if (isToolCallAsText(block.text)) {
        this.logger.log('tool_call_as_text_detected')
        this.onStallDetected('tool_call_as_text')
        return
      }
    }

    // Check for loop
    if (this.loopDetector.addMessage(message)) {
      this.logger.log('loop_detected')
      this.onLoopDetected()
      return
    }

    // Successful message — reset recovery
    this.recovery.recordRecovery()
    this.errorBackoff.reset()
  }

  onToolCall(data) {
    this.logger.log('tool_call', { name: data.name })
  }

  onToolResult(data) {
    this.logger.log('tool_result', { isError: data.message?.isError })
  }

  onRequestError(payload, next) {
    if (this.halted) return next()

    this.logger.counters.errors++
    if (!this.logger.firstError) {
      this.logger.firstError = payload.failure?.message || 'unknown'
    }
    this.logger.log('provider_error', {
      provider: payload.provider,
      failure: payload.failure?.message,
      code: payload.failure?.code,
    })

    const delay = this.errorBackoff.nextDelay()
    if (delay === null) {
      this.logger.log('max_error_retries_reached')
      this.markStepBlocked('max_error_retries')
      return next()
    }

    this.logger.log('error_retry', { delay, retry: this.errorBackoff.retryCount })

    // Wait with backoff, then retry
    setTimeout(() => {
      if (!this.halted) {
        // Return retry action
        // Note: the actual retry is handled by the agent loop when we return { kind: 'retry' }
      }
    }, delay)

    return { kind: 'retry' }
  }

  onStallDetected(reason = 'timeout') {
    if (this.halted) return
    if (this.state === 'stalled' || this.state === 'recovering') return

    this.state = 'stalled'
    this.logger.state = 'stalled'
    this.logger.log('stall_detected', { reason })

    const action = this.recovery.recordStall(this.config.nudgeText)

    switch (action.action) {
      case 'nudge':
        this.sendNudge(action.nudgeText)
        break
      case 'nudge_with_log':
        this.sendNudgeWithLog(action.nudgeText)
        break
      case 'skip':
        this.skipStep()
        break
      case 'blocked':
        this.markStepBlocked('max_recovery_attempts')
        break
    }
  }

  onLoopDetected() {
    if (this.loopCorrected) {
      // Already corrected once, mark blocked
      this.markStepBlocked('persistent_loop')
      return
    }

    this.loopCorrected = true
    this.logger.counters.recoveries++
    this.logger.log('loop_correction_sent')

    const correctiveText = 'You are repeating yourself. State what is blocking you in one sentence, then try a different approach or write NEEDS_DECISION.'
    this.sendMessage(correctiveText)
  }

  sendNudge(text) {
    this.state = 'recovering'
    this.logger.state = 'recovering'
    this.logger.counters.recoveries++
    this.logger.log('nudge_sent', { attempt: this.recovery.stallCount })

    // Abort current turn, then send nudge
    this.agent.cancel({ kind: 'user' })
    this.sendMessage(text)
  }

  sendNudgeWithLog(text) {
    this.state = 'recovering'
    this.logger.state = 'recovering'
    this.logger.counters.recoveries++
    this.logger.log('nudge_with_log_sent', { attempt: this.recovery.stallCount })

    // Read last 20 lines of log
    let logTail = ''
    try {
      if (existsSync(this.paths.logFile)) {
        const lines = readFileSync(this.paths.logFile, 'utf8').trim().split('\n')
        logTail = lines.slice(-20).join('\n')
      }
    } catch {
      // Ignore read errors
    }

    const fullText = logTail
      ? `${text}\n\nLast 20 log lines:\n${logTail}`
      : text

    this.agent.cancel({ kind: 'user' })
    this.sendMessage(fullText)
  }

  skipStep() {
    this.logger.log('step_skipped', { step: this.currentStep })
    this.logger.appendNightLog(this.currentStep, 'skipped', 'Max recovery attempts reached')
    this.sendMessage('Skip this step, take the next one in the brief')
    this.recovery.reset()
  }

  markStepBlocked(reason) {
    this.state = 'blocked'
    this.logger.state = 'blocked'
    this.logger.counters.blocked++
    this.logger.blockedSteps.push(this.currentStep)
    this.logger.log('step_blocked', { step: this.currentStep, reason })
    this.logger.appendNightLog(this.currentStep, 'blocked', reason)
    this.logger.updateStatus()

    // Move to next step
    this.sendMessage('Skip this step, take the next one in the brief')
    this.recovery.reset()
  }

  checkStepCompletion() {
    // Check if the model wrote STEP_DONE
    // This is handled by observing the assistant message content
    // For now, we rely on the step queue mode being driven externally
  }

  sendMessage(text) {
    try {
      // Create a user message and send it as followup
      const message = {
        id: `guard-${Date.now()}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user-rpc' },
      }
      this.agent.followup(message)
      this.logger.log('message_sent')
    } catch (error) {
      this.logger.log('send_failed', { error: error.message })
    }
  }

  checkCaps() {
    if (this.halted) return

    const result = checkCaps(
      {
        ...this.config,
        requests: this.logger.counters.requests,
      },
      this.logger.counters,
      this.logger.startedAt,
      this.paths.stopFile
    )

    if (result.halted) {
      this.halt(result.reason)
    }
  }

  halt(reason) {
    if (this.halted) return
    this.halted = true
    this.haltReason = reason
    this.state = 'halted'
    this.logger.state = 'halted'
    this.logger.log('guard_halted', { reason })
    this.logger.updateStatus()

    const summaryFile = this.logger.writeSummary(reason)
    this.logger.log('summary_written', { file: summaryFile })

    this.clearTimers()
    this.onHalt(reason)
  }
}
