# DESIGN.md — Overnight Guard plugin design

## Choice: A (in-process plugin)

The plugin runs inside the DSH Host process as a Cordis plugin. It observes session events, detects stalls and loops, sends nudges, and enforces caps. No sidecar needed.

## State machine

```
IDLE → ARMED → RUNNING → STALLED → RECOVERING → RUNNING
                ↓         ↓           ↓
              BLOCKED   BLOCKED    BLOCKED
                ↓         ↓           ↓
              HALTED ← HALTED ← HALTED
```

- **IDLE**: Plugin loaded, no active session being guarded.
- **ARMED**: Guard is active for a session, waiting for the first turn to start.
- **RUNNING**: A turn is in progress, events/tokens are flowing.
- **STALLED**: No event or token for `stallSeconds`. Enter recovery ladder.
- **RECOVERING**: Nudge sent, waiting for response. If events resume → RUNNING. If stall again → next ladder step.
- **BLOCKED**: Step marked blocked after max recovery attempts. Send skip message, move to next step.
- **HALTED**: Cap reached or stop file found. No new tasks sent. Summary written.

## Config file

`guard.config.json` in the working folder (or the profile's `cordis.patch.yml` config section):

```json
{
  "stallSeconds": 300,
  "maxRecoveryWindowMinutes": 30,
  "maxErrorRetries": 8,
  "maxRequests": 300,
  "maxHours": 10,
  "bahtPerRequest": 0.266,
  "maxBaht": 100,
  "stopFile": "STOP",
  "nudgeText": "You stopped. Read handoff/NIGHT_LOG.md and the current brief, then continue the current step from where you left off. Do not start over.",
  "briefFile": "handoff/BRIEF.md",
  "stepDoneMarker": "STEP_DONE",
  "logFile": "night-guard.log.jsonl",
  "statusFile": "night-status.json"
}
```

## File formats

**night-guard.log.jsonl** — one JSON line per event:
```json
{"time":"2026-10-22T02:00:00.000Z","step":1,"event":"stall_detected","counter":{"requests":5,"recoveries":1,"blocked":0}}
```

**night-status.json** — updated every 30 seconds:
```json
{"state":"running","currentStep":1,"requests":5,"estimatedBaht":1.33,"recoveries":1,"blockedSteps":[],"startedAt":"2026-10-22T01:00:00.000Z"}
```

**handoff/NIGHT_LOG.md** — markdown table between markers:
```markdown
<!-- night-guard:start -->
| Step | Status | Time | Requests | Notes |
|------|--------|------|----------|-------|
| 1 | done | 2026-10-22T02:00:00Z | 5 | |
<!-- night-guard:end -->
```

**night-summary-YYYY-MM-DD.md** — at most 20 lines on halt.

## Architecture

- `index.js` — plugin entry point, exports `apply(ctx, config)`
- `guard.js` — core guard logic (state machine, timers, event handlers)
- `config.js` — config validation
- `logger.js` — JSONL logging, status file, NIGHT_LOG.md writer
- `detectors.js` — stall detection, loop detection, empty reply detection, tool-call-as-text detection
- `recovery.js` — recovery ladder, backoff, nudge sending
- `caps.js` — cap checking, stop file watching

## Event subscriptions

- `ctx.on('session/event', ...)` — all session events
- `ctx.on('agent/assistant-stream', ...)` — token stream activity
- `ctx.on('agent/request-error', ...)` — provider errors (waterfall, return `{ kind: 'retry' }` to retry)

## Actions

- `agent.followup(message)` — send nudge / next step
- `agent.cancel({ kind: 'user' })` — abort current turn

## Security

- No API keys in logs, files, or error messages
- No shell commands from model output
- No network calls except to the local harness (none needed in-process)
- Log lines contain no message bodies, only metadata
