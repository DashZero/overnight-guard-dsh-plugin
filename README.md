# dsh-overnight-guard

An in-process plugin for DeepSeek Harness that watches long unattended sessions, detects stalls and loops, recovers automatically, and stops cleanly when caps are reached.

## What it does

- **Stall detection**: If no event or token arrives for `stallSeconds` (default 300), the session is stalled. Empty replies and tool-calls-printed-as-text also count as stalls.
- **Recovery ladder**: First stall → abort + nudge. Second stall → nudge with last 20 log lines. Third stall → skip step. After `maxRecoveryWindowMinutes` → blocked.
- **Provider errors**: 503, 429, 524, timeouts → backoff 5, 10, 20, 40, 60 seconds, then retry. After `maxErrorRetries` → blocked.
- **Loop detection**: Same message or same tool call 3 times in a row → corrective nudge. Repeats again → blocked.
- **Caps**: `maxRequests`, `maxHours`, `maxBaht`, and a `stopFile` halt the guard cleanly.
- **Logging**: JSONL event log, status JSON every 30 seconds, NIGHT_LOG.md table, morning summary.

## Install

### macOS

```bash
cd ~/GitHub/dsh-overnight-guard
npm install
npm test
```

Then install the bundle into your DSH profile:

```bash
# Using the DSH CLI (if available)
dsh plugin install ~/GitHub/dsh-overnight-guard

# Or manually: copy to your profile's node_modules and add to cordis.patch.yml
```

### Windows 11 (PowerShell)

```powershell
cd $env:USERPROFILE\GitHub\dsh-overnight-guard
npm install
npm test
```

Then install the bundle into your DSH profile:

```powershell
# Using the DSH CLI (if available)
dsh plugin install $env:USERPROFILE\GitHub\dsh-overnight-guard

# Or manually: copy to your profile's node_modules and add to cordis.patch.yml
```

## Enable

Add to your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: overnight-guard
      name: '@local/dsh-overnight-guard'
      config:
        configFile: guard.config.json
```

Or use the Plugin Manager UI to enable the `overnight-guard` plugin.

## Config

Create `guard.config.json` in your working folder:

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

### Config reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `stallSeconds` | number | 300 | Seconds without events before a stall is detected |
| `maxRecoveryWindowMinutes` | number | 30 | Minutes within which recovery attempts are made |
| `maxErrorRetries` | number | 8 | Max retries for provider errors |
| `maxRequests` | number | 300 | Max requests before halt |
| `maxHours` | number | 10 | Max hours before halt |
| `bahtPerRequest` | number | 0.266 | Cost per request for estimation |
| `maxBaht` | number | 100 | Max estimated cost before halt |
| `stopFile` | string | "STOP" | File that halts the guard when it appears |
| `nudgeText` | string | (see above) | Message sent on first stall |
| `briefFile` | string | "handoff/BRIEF.md" | Brief file for step queue mode |
| `stepDoneMarker` | string | "STEP_DONE" | Marker that completes a step |
| `logFile` | string | "night-guard.log.jsonl" | JSONL event log file |
| `statusFile` | string | "night-status.json" | Status JSON file |

## Files

- `night-guard.log.jsonl` — one JSON line per event (no message bodies, no keys)
- `night-status.json` — current state, updated every 30 seconds
- `handoff/NIGHT_LOG.md` — step table between `<!-- night-guard:start -->` and `<!-- night-guard:end -->`
- `night-summary-YYYY-MM-DD.md` — morning summary on halt

## Stopping

Create a file named `STOP` in the working folder, or let a cap be reached. The guard finishes the current turn, sends no new tasks, writes the summary, and halts.

## Security

- No API keys, tokens, or authorization headers in any log, file, or error message
- No shell commands from model output are executed
- No network calls except to the local harness (none needed in-process)
- Log lines contain only metadata, never message bodies
