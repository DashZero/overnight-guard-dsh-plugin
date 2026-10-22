import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { validateConfig, resolvePaths } from './config.js'
import { OvernightGuard } from './guard.js'

/**
 * dsh-overnight-guard — watches a session, recovers stalls/errors, enforces caps.
 *
 * Plugin config (the Loader entry row's `config`):
 * - `configFile` (string, default "guard.config.json"): name of the guard
 *   config file, resolved against each session's working directory. A session
 *   is guarded only when this file exists in its cwd.
 * - `sessionId` (string, optional): guard only this session id.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ configFile?: string, sessionId?: string }} [config]
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger('overnight-guard')
  const guards = new Map()

  function armGuard(agent) {
    const sessionId = agent.session.id
    if (guards.has(sessionId)) return
    if (config.sessionId && config.sessionId !== sessionId) return

    const cwd = agent.session.header?.cwd
    if (!cwd) {
      logger.info(`session ${sessionId} has no cwd; not guarded`)
      return
    }

    // Guard every session by default; guard.config.json in the session's cwd
    // overrides the defaults. Create a STOP file in the cwd to halt.
    let guardConfig
    const configFile = resolve(cwd, config.configFile ?? 'guard.config.json')
    try {
      guardConfig = existsSync(configFile)
        ? validateConfig(JSON.parse(readFileSync(configFile, 'utf8')), configFile)
        : validateConfig({}, 'defaults')
    } catch (error) {
      logger.error(`invalid guard config ${configFile}: ${error.message}`)
      return
    }

    const paths = resolvePaths(guardConfig, cwd)
    const guard = new OvernightGuard({
      config: guardConfig,
      paths,
      agent,
      ctx,
      onHalt: (reason) => {
        logger.info(`guard halted for session ${sessionId}: ${reason}`)
      },
    })
    guards.set(sessionId, guard)
    guard.start()
    logger.info(`guarding session ${sessionId} (cwd: ${cwd})`)
  }

  // Arm on every agent created after this plugin loads. Payload shape per the
  // live Host Event catalog: { agent, source, signal? }.
  const offCreated = ctx.on('agent/created', ({ agent }) => {
    armGuard(agent)
  })

  // Disarm when an agent leaves the registry. Payload: { agent }.
  const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent.session.id
    const guard = guards.get(sessionId)
    if (guard) {
      guard.stop()
      guards.delete(sessionId)
      logger.info(`guard stopped for session ${sessionId}`)
    }
  })

  // Arm on agents already live (plugin hot-reload case).
  const agents = ctx.get('agents')
  if (agents) {
    for (const agent of agents.list()) {
      armGuard(agent)
    }
  }

  return () => {
    offCreated()
    offDisposed()
    for (const guard of guards.values()) guard.stop()
    guards.clear()
  }
}

export const inject = ['agents']
