import { resolve } from 'node:path'
import { loadConfig, resolvePaths } from './config.js'
import { OvernightGuard } from './guard.js'

/**
 * DSH Overnight Guard plugin.
 *
 * Observes a session for stalls, loops, and provider errors.
 * Recovers automatically and enforces caps.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config) {
  const logger = ctx.logger('overnight-guard')

  // Validate config
  let validatedConfig
  try {
    validatedConfig = loadConfig(config.configFile || 'guard.config.json')
  } catch (error) {
    logger.error('Failed to load config:', error.message)
    throw error
  }

  const workingDir = config.workingDir || process.cwd()
  const paths = resolvePaths(validatedConfig, workingDir)

  logger.info('Overnight guard plugin loaded')
  logger.info('Working directory:', workingDir)
  logger.info('Log file:', paths.logFile)
  logger.info('Status file:', paths.statusFile)

  // Track active guards by session id
  const guards = new Map()

  // Listen for agent creation
  const disposeAgentCreated = ctx.on('agent/created', (agent) => {
    const sessionId = agent.session.id
    logger.info('Agent created for session:', sessionId)

    const guard = new OvernightGuard({
      config: validatedConfig,
      paths,
      agent,
      ctx,
      onHalt: (reason) => {
        logger.info('Guard halted for session', sessionId, ':', reason)
        guards.delete(sessionId)
      },
    })

    guards.set(sessionId, guard)
    guard.start()

    // Clean up when agent is disposed
    ctx.on('agent/disposed', (disposedAgent) => {
      if (disposedAgent === agent) {
        guard.stop()
        guards.delete(sessionId)
        logger.info('Guard stopped for session:', sessionId)
      }
    })
  })

  // Return cleanup
  return () => {
    disposeAgentCreated()
    for (const guard of guards.values()) {
      guard.stop()
    }
    guards.clear()
  }
}

export const inject = ['agents', 'sessions']

export const Config = {
  type: 'object',
  properties: {
    configFile: { type: 'string', default: 'guard.config.json' },
    workingDir: { type: 'string' },
  },
}
