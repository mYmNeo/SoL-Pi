# Configuration

SoL-Pi reads one effective JSON configuration file at extension startup. It resolves the locations through the host's public `CONFIG_DIR_NAME` and `getAgentDir()` APIs rather than assuming fixed directories.

## Search order

1. `<working-directory>/<omp config directory>/sol-pi.json`
2. `<omp agent directory>/sol-pi.json`
3. Built-in defaults when neither file exists

With the official `omp` distribution, the first two locations resolve to `.omp/sol-pi.json` and `~/.omp/agent/sol-pi.json`.

The project file replaces the global file. SoL-Pi does not merge them.

> [!IMPORTANT]
> Upstream Pi is no longer supported. These paths moved from the Pi directory to `.omp/`, so a configuration written for the previous Pi-based release — for example `~/.pi/agent/sol-pi.json` — no longer resolves: SoL-Pi silently uses its defaults and every mechanism stays disabled. Move the file to one of the paths above. There is no automatic migration.

## Schema

```json
{
  "version": 1,
  "actionFusion": false,
  "observationPack": false,
  "evidencePreservingReducer": false,
  "evidencePreservingReducerProvider": "provider-id",
  "evidencePreservingReducerModel": "model-id",
  "onlineContextCompact": false,
  "cacheWriteReadRatio": 12.5
}
```

Feature keys may be omitted and then default to `false`. `cacheWriteReadRatio` may be omitted and then defaults to `12.5`; when present it must be a finite non-negative number, and `0` explicitly means that a cache write adds no cost relative to a cache read. `evidencePreservingReducerProvider` and `evidencePreservingReducerModel` may be omitted and then use the built-in reducer route; when present each must be a non-empty string. Unknown keys, unsupported versions, malformed JSON, non-boolean feature values, invalid ratios, and invalid reducer model fields stop extension loading with a direct error.

For the managed all-enabled installation described in the [agent installation and configuration protocol](../agents-install.md), validate the effective file before starting `omp`:

```bash
node scripts/check-sol-pi-config.mjs \
  --config /absolute/path/to/effective/sol-pi.json \
  --require-all-enabled
```

This preflight does not make every valid SoL-Pi configuration all-enabled. Without `--require-all-enabled`, omitted feature keys retain their normal `false` defaults. The managed workflow uses the flag because its acceptance criterion is that all four mechanisms are active.

## Feature behavior

- `actionFusion`: registers SoL-Pi replacements for the host's `edit` and `write` tools.
- `observationPack`: registers `obs_recall` and a provider-context projection handler.
- `evidencePreservingReducer`: registers a `tool_result` handler and delegates long diagnostic-log reduction to the configured reducer provider/model.
- `evidencePreservingReducerProvider`: provider namespace used to resolve the reducer model through the host's model registry.
- `evidencePreservingReducerModel`: model id used for Evidence-Preserving Reducer.
- `onlineContextCompact`: registers `update_plan` and boundary-driven native compaction after the other SoL-Pi context transformers.
- `cacheWriteReadRatio`: supplies the single economic decision ratio used by Online Context Compact.

## Evidence-Preserving Reducer runtime inputs

The release entry supplies the run label and session-derived storage. It uses one configurable model route:

- **Reducer provider/model** — from `evidencePreservingReducerProvider` and `evidencePreservingReducerModel` in the effective `sol-pi.json`. If omitted, SoL-Pi uses its built-in reducer route. SoL-Pi resolves that model through the host's model registry, resolves its credentials with `getApiKeyAndHeaders()`, and calls `complete` from `@oh-my-pi/pi-ai`. Authentication remains `omp`-managed; do not put credentials in `sol-pi.json`.

## Online Context Compact runtime inputs

The release entry uses two runtime inputs:

- **Context window** — from `ExtensionContext.getContextUsage()`, used for window-pressure protection.
- **Cache write/read ratio** — from `cacheWriteReadRatio` in the effective `sol-pi.json`. The value remains fixed for the session and is not recomputed when the model changes. It drives one runtime decision and is not a cost report.

The configured ratio stays fixed for the loaded extension. The mechanism stores its current plan, progress summaries, request horizon, context growth, and compaction debt as versioned custom entries in the host's session log. When a completed plan step selects compaction, the mechanism stops the run and asks the host for one continuation turn whose context says the compaction is in progress; that continuation rebuilds the plan. The request is made from the host's stop hook, so it stays inside the host's 30-second handler budget. Cancelling or exiting does not schedule an automatic continuation. The mechanism creates no separate Online Context Compact files. The programmatic factory exposes only a matching retained-tail value for installations whose host compaction setting differs from the default.

## oh-my-pi integration

SoL-Pi reads no dedicated environment variables. Evidence-Preserving Reducer resolves its configured reducer provider/model through `ExtensionContext.modelRegistry` and uses `omp`-managed authentication. If the configured reducer model is unavailable or the nested model call fails, the original tool result continues unchanged.

SoL-Pi does not configure shell paths, command prefixes, storage paths, run IDs, provider URLs, reasoning levels, timeouts, or per-mechanism enable flags through environment variables. Apart from the EPR reducer provider/model route in `sol-pi.json`, model selection remains with `omp`. Action Fusion uses the host's default shell behavior. Persistent artifacts are derived from the host's session directory and session ID.

## Project-local configuration

A project-local config can enable file mutation, shell execution, local archival, and remote diagnostic-log reduction. `omp` performs no project-trust gating: project-local settings and extensions load unconditionally, and `ExtensionContext.isProjectTrusted()` always returns `true`, so the project file is read as soon as it exists. Prefer the global file when you want one personal configuration across projects, and treat a project-local `sol-pi.json` in a repository you did not write as untrusted input.
