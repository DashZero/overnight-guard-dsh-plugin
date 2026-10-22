import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const DEFAULTS = {
  stallSeconds: 300,
  maxRecoveryWindowMinutes: 30,
  maxErrorRetries: 8,
  maxRequests: 300,
  maxHours: 10,
  bahtPerRequest: 0.266,
  maxBaht: 100,
  stopFile: 'STOP',
  nudgeText: 'You stopped. Read handoff/NIGHT_LOG.md and the current brief, then continue the current step from where you left off. Do not start over.',
  briefFile: 'handoff/BRIEF.md',
  stepDoneMarker: 'STEP_DONE',
  logFile: 'night-guard.log.jsonl',
  statusFile: 'night-status.json',
}

const REQUIRED_KEYS = Object.keys(REQUIRED_DEFAULTS())

function REQUIRED_DEFAULTS() {
  return DEFAULTS
}

export function loadConfig(configPath) {
  const resolved = resolve(configPath)
  if (!existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`)
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(resolved, 'utf8'))
  } catch (err) {
    throw new Error(`Config file is not valid JSON: ${resolved}: ${err.message}`)
  }
  return validateConfig(raw, resolved)
}

export function validateConfig(raw, source = 'config') {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${source}: config must be a JSON object`)
  }
  const config = { ...DEFAULTS, ...raw }

  // Validate numeric fields
  const numericFields = [
    ['stallSeconds', 1, 86400],
    ['maxRecoveryWindowMinutes', 1, 1440],
    ['maxErrorRetries', 1, 100],
    ['maxRequests', 1, 100000],
    ['maxHours', 0.1, 720],
    ['bahtPerRequest', 0, 1000],
    ['maxBaht', 0, 100000],
  ]
  for (const [key, min, max] of numericFields) {
    const value = config[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw new Error(`${source}: ${key} must be a number between ${min} and ${max}, got ${JSON.stringify(value)}`)
    }
  }

  // Validate string fields
  const stringFields = ['stopFile', 'nudgeText', 'briefFile', 'stepDoneMarker', 'logFile', 'statusFile']
  for (const key of stringFields) {
    const value = config[key]
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`${source}: ${key} must be a non-empty string, got ${JSON.stringify(value)}`)
    }
  }

  // Validate paths are not absolute (they should be relative to working dir)
  const pathFields = ['stopFile', 'briefFile', 'logFile', 'statusFile']
  for (const key of pathFields) {
    const value = config[key]
    if (value.includes('..')) {
      throw new Error(`${source}: ${key} must not contain "..", got ${JSON.stringify(value)}`)
    }
  }

  return config
}

export function resolvePaths(config, workingDir) {
  return {
    stopFile: resolve(workingDir, config.stopFile),
    briefFile: resolve(workingDir, config.briefFile),
    logFile: resolve(workingDir, config.logFile),
    statusFile: resolve(workingDir, config.statusFile),
    nightLogFile: resolve(workingDir, 'handoff', 'NIGHT_LOG.md'),
  }
}
