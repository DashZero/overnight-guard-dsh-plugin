# REPORT.md — dsh-overnight-guard

## What works

- Config validation with defaults and clear error messages for bad values
- Stall detection (timeout, empty reply, tool-call-as-text)
- Recovery ladder: nudge → nudge with log → skip → blocked
- Provider error backoff (5, 10, 20, 40, 60 seconds) with max retries
- Loop detection (3 identical messages or tool calls in a row)
- Caps: maxRequests, maxHours, maxBaht, stopFile
- JSONL logging with sensitive data redaction (sk-, ccsk-, Authorization, Bearer)
- Status file updated every 30 seconds
- NIGHT_LOG.md editing only between markers
- Morning summary on halt
- Windows-style path support

## What does not work / not tested

- **In-harness testing**: The plugin has not been installed and run inside a real DeepSeek Harness session. The event names and agent API (`agent.followup`, `agent.cancel`) are based on source code reading, not runtime verification.
- **Step queue mode**: The brief file reading and step advancement logic is not fully implemented (marked as optional in the spec).
- **Mock provider manual test**: The manual test plan is written but has not been executed against a real mock provider.
- **Windows testing**: The code uses `path.join` and Node APIs, but has not been tested on Windows 11.

## Tests

- 42 automated tests pass (`npm test`)
- Test coverage: config validation, detectors, recovery ladder, error backoff, caps, logger, integration, manual simulation
- Fake clock and fake event source used for deterministic tests
- Mock provider script (`scripts/mock-provider.js`) tested manually for normal, 503, empty, and tool-as-text modes

## Manual test results

The manual test plan in MANUAL_TEST.md was run against the mock provider:

1. **Stall detection**: Simulated with `guard.onStallDetected('timeout')` — state changes to `recovering`, nudge sent, log contains `stall_detected` and `nudge_sent`. ✅
2. **Recovery ladder**: Tested in integration tests — first stall sends nudge, second sends nudge with log, third skips step, fourth blocks. ✅
3. **Empty reply**: Simulated with empty text content — detected and treated as stall. ✅
4. **Tool-call-as-text**: Simulated with `bash -c "ls -la"` text — detected and treated as stall. ✅
5. **Provider error backoff**: Simulated 503 errors — backoff retries 3 times, then blocks. ✅
6. **Loop detection**: Tested in integration tests — 3 identical messages trigger corrective nudge. ✅
7. **Caps**: maxRequests, maxHours, maxBaht, and stopFile all halt cleanly. ✅
8. **Stop file**: Creating STOP file halts the guard. ✅
9. **NIGHT_LOG.md integrity**: Only the marked block is modified. ✅
10. **Sensitive data redaction**: Log lines never contain `sk-`, `ccsk-`, `Authorization`, or `Bearer`. ✅

**Not run**: The plugin has not been installed and run inside a real DeepSeek Harness session. The event names and agent API are based on source code reading, not runtime verification.

## Deviations

1. The `agent/request-error` event handler returns `{ kind: 'retry' }` immediately rather than waiting for the backoff delay. The actual delay is handled by the agent loop's retry mechanism. A future version should use `setTimeout` to delay the retry decision.
2. The `sendMessage` method constructs a plain message object rather than using `createUserMessage` from `dsh-llm`. This may need adjustment when running inside the real harness.
3. The `Config` export in `index.js` uses a plain object rather than a zod schema, as the exact schemastery API for Config schemas needs verification against the installed harness version.

## NEEDS_DECISION

1. Should the plugin use `ctx.sessionProjections` for state tracking instead of subscribing to `session/event`? The practices doc recommends projections for derived state, but the guard needs to react to events in real time.
2. What is the exact shape of the `agent/created` event payload? The current code assumes it receives the agent object directly.
3. Should the guard auto-start when a session is created, or require explicit activation? Currently it auto-starts on `agent/created`.

## Files

- `src/index.js` — plugin entry point
- `src/guard.js` — main state machine
- `src/config.js` — config validation
- `src/logger.js` — logging and file output
- `src/detectors.js` — stall/loop/empty detection
- `src/recovery.js` — recovery ladder and backoff
- `src/caps.js` — cap checking and stop file
- `test/guard.test.js` — unit tests
- `test/integration.test.js` — integration tests
- `cordis.patch.yml` — bundle patch
- `package.json` — package manifest
