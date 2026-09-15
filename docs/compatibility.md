# oh-my-pi Compatibility

SoL-Pi is developed and tested against `omp` 18.2.0, distributed as `@oh-my-pi/pi-coding-agent@18.2.0` and its sibling `@oh-my-pi/*` packages. Every mechanism is a standalone extension loaded through oh-my-pi's public extension APIs; upstream Pi is no longer a supported host. There is no dual-host mode, no compatibility shim for Pi, and no Pi specifier anywhere in `src/`.

SoL-Pi imports only public package exports:

- `createEditToolDefinition`, `createWriteToolDefinition`, and `createBashToolDefinition` from the `@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim` subpath
- extension types and `ExtensionAPI.registerTool`
- `context`, `before_provider_request`, `tool_result`, `turn_end`, `session_stop`, and `session_before_tree` extension events
- native compaction events, `ExtensionContext.getContextUsage()`, and `ExtensionContext.compact()`
- `ExtensionContext.model`, `ExtensionContext.modelRegistry`, and `ExtensionContext.models`
- `findCutPoint` and `Tokenizer` from `@oh-my-pi/pi-agent-core`
- the `Type.*` schema builders from `@oh-my-pi/omptype/typebox`, and `CONFIG_DIR_NAME` from `@oh-my-pi/pi-utils`
- the public session-manager methods exposed through `ExtensionContext`

## Host differences from upstream Pi

These are the verified behavioral deltas the port had to absorb. Each is a host fact, not an SoL-Pi choice.

- **No `agent_settled` event.** omp has no such event; `pi.on("agent_settled", ...)` would register a handler that never fires. The settle point is `session_stop`, whose handler runs before the main session settles and may return `{ continue?: boolean; additionalContext?: string; decision?: "block"; reason?: string }`. SoL-Pi requests its post-compaction continuation by returning `continue` with `additionalContext` instead of relying on a re-dispatch.
- **30-second handler cap.** omp bounds each extension handler at 30 seconds (`EXTENSION_HANDLER_TIMEOUT_MS`); an overrunning handler is killed and its return value discarded. `session_shutdown` has its own 2-second budget. SoL-Pi does not depend on handler return values surviving a long await.
- **`compact()` returns a rejecting promise.** `ExtensionContext.compact(instructionsOrOptions?: string | CompactOptions)` returns `Promise<void>`; the documented options object is `{ onComplete?, onError?, mode?, internalGuidance? }`. There is no `customInstructions` option on `compact()` — that public user-instruction field exists on the `session_before_compact` hook instead, and `internalGuidance` is the host's dedicated channel for internal summarizer guidance that is deliberately never surfaced to that hook. SoL-Pi supplies its boundary instruction through `compact()` and observes completion through `onComplete`/`onError`, while also tolerating a rejection from the returned promise.
- **`getSystemPrompt()` returns `string[]`.** Not a single string. SoL-Pi joins the array before estimating or measuring it.
- **No `ctx.signal`.** `ExtensionContext` carries `abort()`, `isIdle()`, and `hasPendingMessages()`, but no abort signal. Each mechanism therefore works from the signal its own tool call receives — `execute(toolCallId, params, signal, onUpdate, ctx)` — or from an `AbortController` it creates, and tolerates an absent parent signal.
- **`modelRegistry` has no `complete()`.** The registry exposes `find(provider, id)`, `getApiKeyAndHeaders(model)`, `getAvailable`, `getApiKey`, `getProviderBaseUrl`, and `getProviderHeaders`, but no completion method. Evidence-Preserving Reducer therefore resolves the configured reducer model through the registry, resolves its credentials with `getApiKeyAndHeaders()`, and calls `complete` from `@oh-my-pi/pi-ai` directly.
- **`findCutPoint` lives in `@oh-my-pi/pi-agent-core`.** The exported signature is `findCutPoint(entries, tokenizer, startIndex, endIndex, keepRecentTokens)` — it takes a `Tokenizer` as its second argument rather than a bare token estimator. SoL-Pi constructs one `Tokenizer` and reuses it.
- **No `sessionEntryToContextMessages` counterpart.** omp exposes no equivalent helper, so SoL-Pi builds context messages from session entries itself over the `message`, `custom_message`, `branch_summary`, and `compaction` entry kinds.
- **Renderer argument order.** omp calls `renderCall(args, options, theme)` and `renderResult(result, options, theme, args)`.
- **Legacy helpers live on a subpath, not the root.** omp serves the legacy built-in tool helpers at the plain `@oh-my-pi/pi-coding-agent` package-root specifier at runtime, but its published root type declarations omit them — and reaching the root through a load-time specifier shim resolves to `undefined` under `bun test`. SoL-Pi therefore imports `createBashToolDefinition`, `createEditToolDefinition`, `createWriteToolDefinition`, `defineTool`, `estimateTokens`, and their companion option/detail types from `@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim`, which ships real declarations for all of them. Importing the subpath explicitly is the only form that both typechecks and works under `bun test` and in a real `omp` run, so no declaration-merge file is needed.
- **The `input` event has no `streamingBehavior`.** Its result shape is `{ handled?, text?, images? }`, not Pi's `{ action: "continue" }`.
- **Config directory is `.omp`.** `CONFIG_DIR_NAME` is `.omp` and `getAgentDir()` is `~/.omp/agent`, so SoL-Pi reads `<project>/.omp/sol-pi.json` or `~/.omp/agent/sol-pi.json`. Configurations written for the Pi-era `.pi` directory no longer resolve.
- **No project-trust gate.** omp loads project-local settings and extensions unconditionally and `ExtensionContext.isProjectTrusted()` always returns `true`. SoL-Pi's project config therefore always wins when present.

## Action Fusion

The built-in edit/write definitions capture their working directory, so SoL-Pi caches one definition per `ctx.cwd`. Its own per-file queue surrounds the built-in mutation and follow-up command. It does not nest the host's built-in mutation queue.

Action Fusion decodes `file://` targets before the built-in mutation runs; the host rejects a URI-like write target outright. The optional leading `@` is accepted on ordinary paths, and a hashline edit header keeps a `file://` target percent-encoded, because decoding it would make a literal `#` in the filename parse as the snapshot-tag separator. This keeps file URLs, including percent-encoded filenames and the `@` prefix, aligned with the file handled by the built-in mutation tool.

The fused `edit` composes its parameters from the host's own built-in edit definition, so it follows the host's edit shape. One difference is worth recording: the compatibility helper behind `createEditToolDefinition()` builds the tool from a session-less stub, so `EditTool.mode` cannot see an active model and the host's per-model edit-mode downgrade (kimi/mimo/deepseek/stepfun to `replace`) never fires. The fused `edit` therefore always presents the default hashline shape (`{ input }`), even on a model class the host would otherwise serve a `replace`-shaped edit. The host exposes no extension seam to restore that per-model choice (`EditToolOptions.operations` throws), but `edit.mode` remains a normal host setting, so a user who needs the other shape can set `edit.mode` directly. This affects only the shape of the fused `edit` arguments, not the mutation itself: the fused tool drives the same hashline tool it advertised, so the pair stays internally consistent.

The queue covers only fused operations registered by this SoL-Pi instance. External processes, direct built-in-tool calls outside the replacement, and unrelated extensions are not globally locked. SoL-Pi hashes the target immediately before launching `then_run` and skips the command if it observes an intervening content change.

## ObservationPack

ObservationPack changes only the messages projected through the public `context` event. Stored session history remains intact. Original bytes and the JSONL ledger live under the session-derived SoL-Pi directory.

## Evidence-Preserving Reducer

The reducer handles public `tool_result` events and resolves the configured reducer provider/model through the host's model registry. Because `ExtensionContext.modelRegistry` exposes no `complete()`, it resolves authentication for that reducer model through `getApiKeyAndHeaders()` and calls the `complete` function exported by `@oh-my-pi/pi-ai`. The reducer preserves the original result whenever the configured reducer model is unavailable or eligibility, model-call, schema, source-hash, exact-quote, size, or likely-secret checks fail.

All persistent paths use `SessionManager.getSessionDir()` and `getSessionId()` through `ExtensionContext`. SoL-Pi creates no configurable storage-path surface.

The unpublished shared artifact layout is not read or migrated. Each session starts from its own `<sessionDir>/sol-pi/<sessionId>/` directory.

## Online Context Compact

Online Context Compact uses ordinary public `context` and `before_provider_request` handlers. Public handlers run in extension load order, so the SoL-Pi entrypoint registers Online Context Compact after its other context transformers. A third-party transformer loaded later is outside the context-growth observation used by its estimate.

The host does not expose its active retained-tail compaction setting through the public extension context. The extension therefore uses the 20,000-token default (`DEFAULT_KEEP_RECENT_TOKENS`) for its economic estimate. Its programmatic factory accepts an explicit matching value for a non-default host setting.

A plan boundary that selects compaction saves its plan and progress state and stops there — it does **not** abort the run. An extension-initiated `ExtensionContext.abort()` cannot work on this host: the aborted fast path returns before the `session_stop` dispatch, so the settle handler would never run and the boundary compaction could never start. The extension therefore records the boundary at `turn_end` and does its work from the `session_stop` of the natural stop, which is the host's only continuation-capable hook. The handler returns `{ continue: true, additionalContext }` so the host resumes the main session in a new turn against the compacted context and rebuilds the plan, and it does not also call `sendMessage` — the returned continuation is the resume mechanism, and doing both would resume twice.

The handler must return inside the host's 30-second cap, so it starts the compaction on the next macrotask and returns immediately without awaiting it. Deferring is also required for the continuation to survive: `compact()` aborts synchronously, and doing that inline inside the handler makes the settle pass discard the handler's returned continuation. The continuation turn therefore begins while the compaction is still running, which is why the continuation context says the compaction is in progress rather than that it finished. `ctx.compact()` can reject in addition to invoking `onError`; the terminal outcome is claimed at most once, so a rejection and a callback error cannot both report.

The continuation is armed only by a plan boundary that selects compaction. Cancelling or exiting does not schedule one.

SoL-Pi treats the compaction window as busy and cancels `session_before_tree` while its own compaction is in flight, so tree navigation cannot move the active leaf underneath the compaction. Navigation works normally once that compaction settles.

Online Context Compact reads `ExtensionContext.getContextUsage()` for both the context window and the provider-counted context size. When the host reports no size — as it does between a compaction and the next answered request — the boundary falls back to its own estimate.

The standalone entry passes `cacheWriteReadRatio` from `sol-pi.json` directly into Online Context Compact's economic check. It does not inspect model price metadata. Changing models during a session does not change the ratio; users who want a different decision policy update the configuration and start a new session.

## Interactive TUI

The lightning savings treatment uses the host's public `renderCall`, `renderResult`, `ctx.ui.notify()`, and keyed `ctx.ui.setStatus()` APIs. It checks `ctx.mode === "tui"` rather than `ctx.hasUI`, because RPC mode also reports UI support. The renderer therefore changes only the interactive terminal display; it does not change session messages, provider requests, tool results, JSON events, print output, or RPC UI requests.

## Test doubles

The test suite drives every extension through the same public `ExtensionAPI` and `ExtensionContext` surface the host provides, over a real public `SessionManager`, without calling a remote model provider. That keeps the suite zero-spend. Suites that need a genuine session tree — branch order, compaction entries, custom entries, resume — use `SessionManager.inMemory()` or `SessionManager.create()` rather than reimplementing them. `tests/host-compat.test.ts` covers the host-normalization layer and `tests/render-order.test.ts` pins the host's renderer argument order.

The tests run under Bun, because the `@oh-my-pi/*` runtime packages ship raw TypeScript and a native addon and cannot be imported by Node at all. `tests/pi-package-integration.test.ts` boots a real `omp` agent session, loads the actual TypeScript entrypoint, reads an all-enabled project configuration, and executes a fused write/command and a plan update against a mock provider. `tests/online-context-compact-agent-session.test.ts` verifies one and two consecutive native compactions and the continuation the stop hook requests. These integration tests run against an offline mock provider; they verify runtime compatibility, not live provider authentication or token savings.
