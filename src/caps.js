import { existsSync } from 'node:fs'

/**
 * Check whether any cap has been reached or the stop file exists.
 */
export function checkCaps(config, counters, startedAt, stopFilePath) {
  const now = Date.now()
  const elapsedMs = now - new Date(startedAt).getTime()
  const elapsedHours = elapsedMs / (1000 * 60 * 60)

  if (config.maxRequests > 0 && config.requests >= config.maxRequests) {
    return { halted: true, reason: `max_requests_reached (${config.requests}/${config.maxRequests})` }
  }
  if (config.maxHours > 0 && elapsedHours >= config.maxHours) {
    return { halted: true, reason: `max_hours_reached (${elapsedHours.toFixed(1)}/${config.maxHours})` }
  }
  if (config.maxBaht > 0) {
    const estimatedBaht = config.requests * config.bahtPerRequest
    if (estimatedBaht >= config.maxBaht) {
      return { halted: true, reason: `max_baht_reached (${estimatedBaht.toFixed(2)}/${config.maxBaht})` }
    }
  }
  if (existsSync(stopFilePath)) {
    return { halted: true, reason: `stop_file_found (${stopFilePath})` }
  }
  return { halted: false }
}

/**
 * Watch the stop file for appearance.
 * Uses polling only (fs.watch fails on non-existent files on some platforms).
 * @param {string} stopFilePath
 * @param {() => void} onStop
 * @returns {() => void} unwatch function
 */
export function watchStopFile(stopFilePath, onStop) {
  if (existsSync(stopFilePath)) {
    onStop()
    return () => {}
  }

  // Poll every 5 seconds (fs.watch on non-existent files throws ENOENT on macOS)
  const interval = setInterval(() => {
    if (existsSync(stopFilePath)) {
      onStop()
    }
  }, 5000)
  // Don't keep the process alive just for this watcher
  interval.unref()

  return () => {
    clearInterval(interval)
  }
}
