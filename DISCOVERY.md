# DISCOVERY.md — DeepSeek Harness plugin architecture for overnight guard

## 1. How is a plugin declared, loaded and configured?

A plugin is a Cordis plugin mounted by the Loader (`@deepseek-ai/cordis-plugin-loader`).

**File layout:**
- A bundle is an npm package with `package.json` containing `dsh.bundle.patch` pointing to a YAML patch file (e.g. `cordis.patch.yml`).
- The patch file contains a list of `- insert:` entries with `id`, `name` (module specifier), `config`, and optional `disabled` / `inject`.
- The plugin entry point is a JS module exporting either `apply(ctx, config)` or a Service class as default export.

**Loading:**
- The Loader (`Loader` class in `cordis-plugin-loader`) reads the profile's `cordis.patch.yml` and bundle patches, resolves module specifiers, imports them, and calls `ctx.registry.plugin(plugin, config)`.
- Plugins are loaded in the Host process (Node.js), not in the browser.
- The profile directory is at `$DSH_PROFILE_DIR` (macOS: `~/Library/Application Support/DeepSeek Harness/profiles/<name>`; Windows: `%APPDATA%\DeepSeek Harness\profiles\<name>`).

**Configuration:**
- A plugin can declare a `Config` schema (using `@deepseek-ai/schemastery` / zod) which validates the `config` object from the patch entry.
- Config values can be `volatile()` (hot-reloadable) or static.
- Users edit the profile's `cordis.patch.yml` or use the Plugin Manager UI to enable/disable and configure plugins.

## 2. Which lifecycle events can a plugin observe?

From reading `dsh-agent-loop`, `dsh-agent`, `dsh-session`, and `dsh-api-session-controller`:

**Session events (via `ctx.on('session/event', ...)` on the session subject):**
- `turn/start` — `{ turn, step }` when a turn begins
- `turn/end` — `{ turn, step, reason }` when a turn ends (reason: `completed`, `blocked`, `aborted`, `interrupted`, `error`, `max-tokens`, `forked`)
- `assistant/message` — `{ turn, step, message, usage?, stream }` when an assistant message is committed
- `assistant/attempt` — `{ turn, step, stream }` for a failed/aborted attempt
- `tool/call` — `{ turn, step, callId, name, arguments }` when a tool call is made
- `tool/result` — `{ turn, step, message, error?, meta? }` when a tool result is committed
- `user/message` — when a user message is appended
- `model/selection` — when model selection changes

**Agent events (via `agentEvents` dispatch, or `ctx.on('agent/...', ...)`):**
- `agent/assistant-stream` — `{ frame }` with `type: 'start' | 'chunk' | 'end'` for live token streaming
- `agent/request-error` — `{ turn, step, provider, failure, retryPolicy, signal }` on provider errors (waterfall mode; returning `{ kind: 'retry' }` causes retry)
- `agent/created` — when an agent is created
- `agent/disposed` — when an agent is disposed

**Workspace events:**
- `workspace/session-activity` — session activity notifications
- `workspace/session-stop` — session stop requests

**Payload shapes:** All session events have `seq`, `time`, `type`, `data`. The `data` field contains the type-specific payload above. Events are JSON-serializable and deeply frozen after append.

## 3. Can a plugin send a user message into a running session, abort the current turn, and resume or re-run the last turn?

**Send a user message:** Yes. The `Agent` object has `followup(message)` and `steer(message)` methods. The `dsh-api-session-controller` uses `agent.followup(message)` for normal prompts and `agent.steer(message)` for steering. A plugin can get the agent via `ctx.agents.get(sessionId)` and call `agent.followup(createUserMessage({ content: [{ type: 'text', text: '...' }] }))`.

**Abort the current turn:** Yes. `agent.cancel({ kind: 'user' })` cancels the current turn. This is what the stop button does.

**Resume or re-run the last turn:** There is no direct "re-run last turn" API. However, after a turn ends (or is aborted), sending a new `followup` message starts a new turn with the full session history. The agent loop will re-read the session log and continue. So "resume" = send a new prompt; "re-run" = abort + send a new prompt with instructions to continue.

## 4. How are sessions stored, and can they be resumed after a crash?

Sessions are stored as JSONL event logs via `dsh-session-persistence-jsonl`. Each session has:
- A header (id, createdAt, cwd, parentSession, isSeeded, etc.)
- A contiguous log of events (`session/event` types)
- The log is append-only; events are validated on append

**Crash recovery:** Yes. On resume, the persistence layer reads the log, appends `interruptedTurnClosers` for any torn tail, and reconstructs the session. The `AgentLoop.resume()` method opens the persistence handle, reads events, and rebuilds the session state. Sessions can be resumed after a crash.

## 5. Does the local Web UI server expose an API a separate script could use?

Yes. The `dsh-api-gateway` exposes a WebSocket-based Typert Remote API. The `dsh-api-session-controller` exposes Remote methods for:
- `session.prompt` — send a prompt to a session
- `session.resume` — resume a session
- `session.stop` — stop a session
- `session.list` — list sessions
- `session.history` — read session history
- `session.control` — stream of session control events

The Web UI server runs on `http://127.0.0.1:3080` (or the port shown in the GUI). The WebSocket endpoint is at the same origin. However, the Typert protocol is not a simple REST API; it uses a custom multiplexed WebSocket protocol with typed methods. A sidecar would need to implement the Typert client protocol or use the `dsh-api-gateway` client library.

**Simpler alternative:** The `dsh-api-session-controller` also exposes HTTP endpoints via the web server for some operations, but the primary API is WebSocket/Typert.

## 6. Known bugs that affect plugins

**Per-model settings ignored:** The `dsh-agent-default-model` plugin provides a default model selection. The `dsh-api-session-controller` installs a `modelSelection` projection per agent. The issue reported (per-model settings of another plugin ignored) likely occurs because:
- The `AgentLoop.prepareRequest()` method reads `this.options.reasoningEffort` and `this.options.maxTokens` from the agent options, not from the plugin config
- Plugin config changes via `cordis.patch.yml` are hot-reloaded only for `volatile()` fields; non-volatile changes require a restart
- The `loader/volatile-update` event is dispatched to the owning fiber only; if a plugin caches config values in closures, it won't see updates

**Other observations:**
- The `session/event` listener receives events synchronously on append; long-running listeners can block the session
- The `agent/assistant-stream` event is emitted per chunk; high-frequency listeners should be lightweight
- Session persistence is asynchronous (buffered, batched every 200ms); a crash may lose the last 200ms of events

## DESIGN CHOICE

Questions 2 and 3 are fully possible in-process:
- A plugin can observe all needed events via `ctx.on('session/event', ...)` and `ctx.on('agent/assistant-stream', ...)`
- A plugin can send messages via `agent.followup()` and abort via `agent.cancel()`
- No need for the WebSocket API or a sidecar process

DESIGN CHOICE = A (in-process plugin)
