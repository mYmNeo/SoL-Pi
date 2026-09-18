# SoL-Pi Agent Installation and Configuration Protocol

This is the canonical procedure for Codex, Claude Code, and other coding agents that install, configure, or validate SoL-Pi from a full source checkout. Follow the phases in order. Explicit user instructions take precedence. An extracted npm package is not a substitute for the checkout because it does not contain the test suite.

Installation and configuration are complete only when oh-my-pi remains unmodified, the repository checks pass, `omp` lists the extension, all four mechanisms are enabled in one effective `sol-pi.json`, and `omp` starts without an extension error.

## Rules

- Do not modify, patch, fork, or vendor oh-my-pi. SoL-Pi must load as a standalone extension through `omp`'s public extension interface.
- **oh-my-pi only.** Upstream Pi is no longer supported: do not add an upstream Pi package specifier, a Pi dependency, a bare `typebox` specifier, or a Pi-era `.pi` configuration path anywhere in the checkout.
- Use Bun 1.3.14 or newer and the tested oh-my-pi release `@oh-my-pi/pi-coding-agent@18.2.5` (`omp` 18.2.5). Node.js 22.19 or newer is required only to run the standalone repository scripts. Treat a different `omp` version as a compatibility change and rerun the full suite before using it.
- Do not clean, reset, switch, or overwrite unrelated repository changes.
- Do not print, log, commit, upload, or include any secret in a command line. Check only whether a credential is present.
- Keep SoL-Pi settings in `sol-pi.json`. The Evidence-Preserving Reducer provider/model route is a SoL-Pi setting; provider URLs, credentials, the main agent model, and shell behavior remain `omp` settings.
- Keep persistent artifacts under the session-derived `sol-pi/<session-id>/` root; do not configure a separate storage path.

## Inputs

Resolve these values before making changes:

- `sol_pi_root`: absolute path to the intended SoL-Pi checkout;
- `target_project`: project in which `omp` will run;
- install scope: project-local or user-wide;
- exact SoL-Pi branch and commit.

Do not guess an ambiguous path or install scope.

## Phase 1: validate the checkout

From `sol_pi_root`, record the repository state without changing it:

```bash
git status --short --branch
git rev-parse HEAD
bun --version
node --version
```

Require Bun 1.3.14 or newer and Node.js 22.19 or newer. Install from the lockfile and run the source checks:

```bash
bun install --frozen-lockfile
bun run check
bun audit --audit-level=high
node scripts/check-omp-compat.mjs
bun test tests/all-mechanisms.test.ts
```

`bun run check` covers type checking and the complete test suite. `bun test tests/all-mechanisms.test.ts` confirms that one all-enabled configuration registers all four mechanisms against the host's public extension API. `node scripts/check-omp-compat.mjs` verifies that the installed `@oh-my-pi/*` packages are exactly 18.2.5, that `package.json` declares `omp.extensions` pointing at `src/sol-pi/index.ts`, that no upstream Pi specifier remains under `src/`, and that all four mechanism entrypoints exist. The test suite runs without a model provider.

Stop if any command fails. Do not hide a failure with `|| true` or replace `bun install --frozen-lockfile` with an unlocked install.

## Phase 2: install oh-my-pi and register SoL-Pi

Install the tested oh-my-pi release without changing its source:

```bash
bun install --global @oh-my-pi/pi-coding-agent@18.2.5
omp --version
```

Require `omp --version` to report `18.2.5`.

For a user-wide registration, run this from `target_project` and substitute the resolved absolute `sol_pi_root`. Linking a local path keeps the checkout as the live extension source:

```bash
omp plugin link "/absolute/path/to/SoL-Pi"
omp plugin list
```

The `omp plugin list` output must show the exact SoL-Pi entry. Do not register the same checkout twice.

For a local checkout, `omp plugin link` links the working tree rather than copying it, which is the form this protocol uses; `omp plugin install` is for installing a package or a straight install. The package must declare its entry points under `package.json#omp.extensions` (this repo declares `./src/sol-pi/index.ts`) for the registration to load an extension.

A local-path link registers the checkout for the user: in verification the project directory stayed empty and `omp plugin list` reported the plugin from an unrelated working directory. `omp plugin` advertises `--scope=user|project`, but the CLI warns that it is ignored for a local path. For a project-local registration, use one of the native discovery mechanisms instead:

- add the checkout to `<target_project>/.omp/config.yml`:

  ```yaml
  extensions:
    - /absolute/path/to/SoL-Pi
  ```

- or place or symlink the checkout under `<target_project>/.omp/extensions/`, for example `<target_project>/.omp/extensions/sol-pi`.

`omp` also honors the `omp.extensions` array in a package manifest. For a single run without registering anything, load the entry file directly:

```bash
omp -e /absolute/path/to/SoL-Pi/src/sol-pi/index.ts -p "Reply with OK and nothing else."
```

`omp --no-extensions` disables discovery while explicit `-e` paths still load.

## Phase 3: configure all four mechanisms

SoL-Pi defaults every mechanism to disabled. For this managed installation, create exactly one effective configuration with every mechanism enabled:

```json
{
  "version": 1,
  "actionFusion": true,
  "observationPack": true,
  "evidencePreservingReducer": true,
  "evidencePreservingReducerProvider": "provider-id",
  "evidencePreservingReducerModel": "model-id",
  "onlineContextCompact": true,
  "cacheWriteReadRatio": 12.5
}
```

`evidencePreservingReducerProvider` and `evidencePreservingReducerModel` select the nested reducer route that Evidence-Preserving Reducer resolves through the host's model registry. They default to the built-in reducer route and must be non-empty strings when supplied. Change them only when a different reducer model is intended.

`cacheWriteReadRatio` is the only pricing-related input SoL-Pi reads. It defaults to `12.5`, accepts any finite non-negative number, and treats `0` as an explicit statement that a cache write adds no cost relative to a cache read. SoL-Pi does not inspect model prices. The value controls one compaction decision and is not a bill estimate. The default follows the GPT-5.6 Sol OpenAI Standard cache-write/read ratio checked on 2026-08-21; see [OpenAI API pricing](https://developers.openai.com/api/docs/pricing). Change it when a different policy is required.

Use one location matching the selected scope. SoL-Pi resolves the directories through the host's public `CONFIG_DIR_NAME` and `getAgentDir()` APIs; the official `omp` values are shown in parentheses:

- project-local: `<target_project>/<omp config directory>/sol-pi.json` (`<target_project>/.omp/sol-pi.json`);
- user-wide: `<omp agent directory>/sol-pi.json` (`~/.omp/agent/sol-pi.json`).

Do not assume the defaults when the host reports different directories.

Upstream Pi is no longer supported. A configuration written for the previous Pi-based release, such as `~/.pi/agent/sol-pi.json`, therefore no longer resolves: SoL-Pi silently uses its defaults and every mechanism stays disabled. Move the file to one of the paths above. There is no automatic migration, so do not invent one.

The project file replaces the user-wide file; the two are not merged. If both exist, inspect them and obtain direction before changing either one. Unknown keys, unsupported versions, malformed JSON, non-boolean feature values, invalid reducer model fields, and invalid ratios must remain fatal.

`omp` performs no project-trust gating, so the project file is read as soon as it exists; there is no trusted-project precondition to satisfy.

Do not put provider URL, credentials, shell path, command prefix, storage path, or run ID in `sol-pi.json`. SoL-Pi either reads those values from `omp` or derives them from the host session.

SoL-Pi reads no dedicated environment variables. Evidence-Preserving Reducer uses the configured reducer provider/model route and `omp`-managed authentication. Configure credentials in `omp` and do not copy them into `sol-pi.json`.

From `sol_pi_root`, validate the exact effective file:

```bash
node scripts/check-sol-pi-config.mjs \
  --config /absolute/path/to/effective/sol-pi.json \
  --require-all-enabled
```

Require exit status 0 and retain its JSON output. The check applies SoL-Pi's default values, rejects unknown keys and wrong types, and confirms all four mechanisms are enabled. A partially enabled file can be valid SoL-Pi configuration, but it does not satisfy this all-enabled profile.

## Phase 4: verify the installation

1. Run `omp plugin list` from `target_project` and confirm the expected SoL-Pi entry and its resolved path.
2. Run `node scripts/check-omp-compat.mjs` from `sol_pi_root` and confirm the pinned host versions and the four mechanism entrypoints.
3. Run `check-sol-pi-config.mjs --require-all-enabled` against the effective `sol-pi.json`.
4. Re-run `bun test tests/all-mechanisms.test.ts` from `sol_pi_root`.
5. Start `omp` with a real run that loads the extension and confirm there is no extension load error:

   ```bash
   omp -p "Reply with OK and nothing else."
   ```

   A load failure is printed before the run output, in the form `Failed to load extension <path>: ...`, for example when a module cannot resolve a host symbol: `Failed to load extension <path>: Failed to load extension: Export named '<symbol>' not found in module 'omp-legacy-pi-bundled:...'`. Require that line to be absent and the run to complete.
6. Confirm that oh-my-pi was not patched and that the SoL-Pi checkout contains no vendored oh-my-pi source and no upstream Pi specifier, dependency, or configuration path.

## Completion report

Report:

- SoL-Pi absolute path, branch, and commit;
- repository state before and after installation;
- Bun, Node, and `omp` versions;
- registration form (user-wide plugin link, project `.omp/config.yml`, or project `.omp/extensions/`) and the exact entry shown by `omp plugin list`;
- effective config path, four enabled flags, EPR reducer provider/model, and `cacheWriteReadRatio`, without secrets;
- every validation command and result;
- any blocker or deviation.

Do not describe the installation as successful if a required check is missing.

## Agent entry files

`agents-install.md` is the single source of truth, but agents do not universally auto-discover arbitrary filenames. Root `AGENTS.md` tells Codex to read this file, while root `CLAUDE.md` imports it for Claude Code. Keep those entry files short and keep executable installation details here.

- [Codex `AGENTS.md` discovery](https://developers.openai.com/codex/guides/agents-md)
- [Claude Code project memory and imports](https://docs.anthropic.com/zh-CN/docs/claude-code/memory)
