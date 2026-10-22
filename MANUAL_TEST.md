# MANUAL_TEST.md — Manual test plan for dsh-overnight-guard

## Prerequisites

- DeepSeek Harness Desktop installed and running
- A session with a model that can be controlled (e.g., a mock provider or a real session you can watch)
- The plugin installed and enabled (see README.md)

## Test 1: Stall detection and recovery

1. Start a session with a long-running task.
2. Configure `stallSeconds: 10` for fast testing.
3. Let the session go quiet (do not interact).
4. **Expected**: After 10 seconds, the guard detects the stall, aborts the turn, and sends the nudge message.
5. **Check**: `night-guard.log.jsonl` contains `stall_detected` and `nudge_sent` events.
6. **Check**: `night-status.json` shows `state: "recovering"`.

## Test 2: Recovery ladder (a, b, c)

1. Continue Test 1. Let the session stall again.
2. **Expected**: Second stall sends nudge with last 20 log lines prepended.
3. Let it stall a third time.
4. **Expected**: Third stall sends "Skip this step, take the next one in the brief".
5. Let it stall a fourth time.
6. **Expected**: Step is marked blocked in `NIGHT_LOG.md`.

## Test 3: Empty reply detection

1. Use a mock provider that returns an empty assistant message.
2. **Expected**: The guard detects the empty reply and treats it as a stall.
3. **Check**: Log contains `empty_reply_detected`.

## Test 4: Tool-call-as-text detection

1. Use a mock provider that returns a text block like `bash -c "ls -la"` instead of a real tool call.
2. **Expected**: The guard detects the tool-call-as-text and treats it as a stall.
3. **Check**: Log contains `tool_call_as_text_detected`.

## Test 5: Provider error backoff

1. Use a mock provider that returns 503 errors.
2. **Expected**: The guard retries with backoff 5, 10, 20, 40, 60 seconds.
3. After `maxErrorRetries` (default 8), the step is marked blocked.
4. **Check**: Log contains `provider_error` and `error_retry` events with increasing delays.

## Test 6: Loop detection

1. Use a mock provider that returns the same message 3 times in a row.
2. **Expected**: The guard sends a corrective nudge: "You are repeating yourself..."
3. If it repeats again, the step is marked blocked.
4. **Check**: Log contains `loop_detected` and `loop_correction_sent`.

## Test 7: Caps

1. Set `maxRequests: 5`.
2. Let the session make 5 requests.
3. **Expected**: The guard halts with reason `max_requests_reached`.
4. **Check**: `night-summary-YYYY-MM-DD.md` is written.

## Test 8: Stop file

1. While a session is running, create a file named `STOP` in the working folder.
2. **Expected**: The guard detects the file and halts cleanly.
3. **Check**: Log contains `guard_halted` with reason `stop_file_found`.

## Test 9: NIGHT_LOG.md integrity

1. Before running, add content to `handoff/NIGHT_LOG.md` outside the markers.
2. Run the guard and let it complete some steps.
3. **Expected**: Only the block between `<!-- night-guard:start -->` and `<!-- night-guard:end -->` is modified.
4. **Check**: Content before and after the markers is unchanged.

## Test 10: Sensitive data redaction

1. Trigger an error that might contain an API key (e.g., a 401 error).
2. **Expected**: The log contains `[REDACTED]` instead of the key.
3. **Check**: Log file does not contain `sk-`, `ccsk-`, `Authorization`, or `Bearer`.

## Mock provider setup

To test without a real provider, create a mock provider that:
- Returns 503 for the first N requests
- Returns empty responses
- Returns tool-call-as-text
- Hangs (no response)

Example mock provider configuration (in DSH settings):

```json
{
  "provider": "mock",
  "model": "mock-hang",
  "baseUrl": "http://localhost:9999"
}
```

Run a simple mock server:

```bash
node -e "
const http = require('http');
http.createServer((req, res) => {
  if (req.url.includes('hang')) {
    // Never respond
    return;
  }
  if (req.url.includes('503')) {
    res.writeHead(503);
    res.end('Service Unavailable');
    return;
  }
  if (req.url.includes('empty')) {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({choices: [{message: {content: ''}}]}));
    return;
  }
  res.writeHead(200, {'Content-Type': 'application/json'});
  res.end(JSON.stringify({choices: [{message: {content: 'OK'}}]}));
}).listen(9999);
"
```

## What to check in the log

After each test, verify:

1. `night-guard.log.jsonl` has one JSON line per event
2. No line contains `sk-`, `ccsk-`, `Authorization`, or `Bearer`
3. `night-status.json` is updated every 30 seconds
4. `NIGHT_LOG.md` only changes between the markers
5. `night-summary-YYYY-MM-DD.md` is written on halt and is at most 20 lines
