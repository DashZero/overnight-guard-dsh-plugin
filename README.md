# dsh-overnight-guard

An in-process plugin for DeepSeek Harness that watches long unattended sessions, detects stalls and provider errors, recovers automatically, and stops cleanly when caps or unfixable errors are reached.

## What it does

- **Automatic Failure Recovery**: Detects transient model/stream failures (e.g. `"The upstream service could not complete this stream."`, `"Connection error."`) and automatically sends a continuation message so unattended jobs don't stop mid-task.
- **Provider Error Backoff**: Retries transient provider errors (503, 429, 524, timeouts) with bounded backoff (5s, 10s, 20s, 40s, 60s, max 8 retries).
- **Quota Reset Awareness**: Detects quota reset windows (`"reset after 8m 49s"`) and pauses until the reset time if within `maxResetWaitSeconds` (default 10 min), or halts cleanly if too long.
- **Immediate Halt on Unfixable Errors**: If the model is not supported, not in the pool, or credentials fail, the guard halts immediately rather than looping.
- **No False Alarms on Finished Sessions**: Does NOT wake or restart sessions that have completed normally (`completed` or `aborted`).
- **Caps & Safeguards**: Enforces `maxRequests`, `maxHours`, `maxBaht`, and a `STOP` file.
- **Logging**: JSONL event log (`night-guard.log.jsonl`), status JSON every 30 seconds (`night-status.json`), and a morning markdown summary on halt.

---

## How to Install on Another Machine

### Option A: Direct from GitHub in DeepSeek Harness (Recommended)

In DeepSeek Harness on your other machine, simply open any session and ask the AI Agent:

> *"Please install the bundle `github:DashZero/overnight-guard-dsh-plugin` using plugin_manager."*

The harness will fetch it from GitHub, link it into the profile, and enable it automatically.

---

### Option B: Clone and Install Locally

#### macOS / Linux
```bash
# 1. Clone the repository
git clone https://github.com/DashZero/overnight-guard-dsh-plugin.git ~/GitHub/dsh-overnight-guard

# 2. In DeepSeek Harness, ask the agent or run:
# plugin_manager install_bundle target: "~/GitHub/dsh-overnight-guard"
```

#### Windows 11 (PowerShell)
```powershell
# 1. Clone the repository
git clone https://github.com/DashZero/overnight-guard-dsh-plugin.git $env:USERPROFILE\GitHub\dsh-overnight-guard

# 2. In DeepSeek Harness, ask the agent or run:
# plugin_manager install_bundle target: "$env:USERPROFILE\GitHub\dsh-overnight-guard"
```

---

## Activating and Restarting

After installing the bundle for the first time or pulling updates, **restart DeepSeek Harness Desktop** so the process loads the fresh module generation.

Once active:
- Every session with a workspace/cwd is guarded by default.
- To customize settings for a specific repository, place a `guard.config.json` in the root of that repository.
- To immediately stop the guard at any time, create an empty file named `STOP` in your project folder.

---

## Configuration (`guard.config.json`)

Optional. Place `guard.config.json` in your project's working directory to override defaults:

```json
{
  "stallSeconds": 300,
  "maxErrorRetries": 8,
  "maxResetWaitSeconds": 600,
  "maxRequests": 300,
  "maxHours": 10,
  "bahtPerRequest": 0.266,
  "maxBaht": 100,
  "stopFile": "STOP"
}
```

### Config Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `stallSeconds` | number | 300 | Seconds without events before an active turn is flagged as stalled |
| `maxErrorRetries` | number | 8 | Max retries for transient provider errors before halting |
| `maxResetWaitSeconds` | number | 600 | Max quota-reset wait (seconds) before giving up and halting |
| `maxRequests` | number | 300 | Max requests before halt |
| `maxHours` | number | 10 | Max runtime hours before halt |
| `bahtPerRequest` | number | 0.266 | Cost per request for estimate |
| `maxBaht` | number | 100 | Max estimated spend before halt |
| `stopFile` | string | "STOP" | File name that halts the guard when present |
| `logFile` | string | "night-guard.log.jsonl" | Per-session JSONL event log |
| `statusFile` | string | "night-status.json" | Per-session status JSON (updated every 30s) |

---

## Development & Tests

```bash
npm test
```
Runs the 60 unit, detector, recovery, cap, and integration tests using Node's built-in test runner. No external dependencies required.
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
