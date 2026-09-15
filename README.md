<p align="center">
  <img src="assets/sol-pi-hero.png" width="100%" alt="SoL-Pi: Scaling Auto-Research Loops for Efficient Agent Harnesses" />
</p>

# ⚡ SoL-Pi: Scaling Auto-Research Loops for Efficient Agent Harnesses

<p align="center">
  <a href="#paper"><img src="https://img.shields.io/badge/arXiv-Coming%20soon-B31B1B?logo=arxiv&amp;logoColor=white" alt="arXiv: Coming soon" /></a>
  <a href="#getting-started"><img src="https://img.shields.io/badge/Getting%20Started-Install-76B900" alt="Getting Started" /></a>
  <a href="docs/configuration.md"><img src="https://img.shields.io/badge/Docs-Configuration-555555" alt="Configuration" /></a>
  <a href="https://nvlabs.github.io/SoL-Pi/"><img src="https://img.shields.io/badge/Blog-SoL--Pi-76B900" alt="SoL-Pi Blog" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" /></a>
</p>

> [!NOTE]
> This repository contains the open-source version of SoL-Pi, a standalone extension for [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`). It is not an official distribution of oh-my-pi. Upstream Pi is no longer a supported host.

## 💡 TL;DR

**Spend less without making the agent do less useful work.**

SoL-Pi is a standalone extension for oh-my-pi that packages four reusable efficiency mechanisms discovered through scaled auto-research loops. It reduces repeated model turns, context replay, oversized observations, and unnecessary long-log reading while preserving the work and evidence an agent needs to finish a task.

SoL-Pi runs on top of an unmodified `omp` 18.2.0 release. Every mechanism is opt-in and disabled by default.

## Introduction

Long-running coding agents accumulate repeated work. A file edit is often followed by a predictable validation command. Large tool results are replayed long after their first use. Completed subtasks remain in active context, and a frontier model may spend a full request reading a log when only a few lines affect the next decision.

SoL-Pi grew out of a broader question from our auto-research work: before scaling agent loops, can agents first make the harness itself more efficient? The search focused on constrained efficiency: reducing token traffic, inference work, and agent turns without stopping early, skipping verification, or hiding evidence.

The standalone release contains four mechanisms that survived that process. They operate at different parts of the harness and compose through oh-my-pi's public extension APIs.

## What SoL-Pi Adds

| Area | Mechanism | What changes |
|---|---|---|
| Tools | **Action Fusion** | An edit or write can run its follow-up validation command in the same tool call. |
| Observations | **ObservationPack** | Repeated large text results become stable handles with exact paged recall. |
| Delegation | **Evidence-Preserving Reducer** | Long diagnostic logs become compact receipts only when every retained quotation matches the archived source. |
| Context | **Online Context Compact** | Completed plan steps become candidate points for the host's native compaction, subject to economic and window-pressure checks; after a successful compaction, the host continues the task in a new turn. |

The mechanisms share four rules:

- **No host patches.** SoL-Pi imports public oh-my-pi APIs and does not vendor the oh-my-pi source tree.
- **Explicit opt-in.** A missing configuration leaves every mechanism disabled.
- **Preserve evidence.** Original observations remain available locally, and reducer failures leave the original result unchanged.
- **Use the host's runtime choices.** Authentication, provider URLs, the main model, and shell behavior remain under `omp`'s control.

## Technical Details and Core Insights

Read the [SoL-Pi blog](https://nvlabs.github.io/SoL-Pi/) for a deeper look at the technical details, design rationale, and core insights behind SoL-Pi, including how auto-research led to the four efficiency mechanisms and how they work.

## Paper

The arXiv preprint is coming soon.

## Getting Started

### Requirements

- Bun 1.3.14 or newer
- [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) 18.2.0, distributed as `@oh-my-pi/pi-coding-agent@18.2.0`
- Node.js 22.19 or newer, only to run the standalone repository scripts (`scripts/check-omp-compat.mjs`, `scripts/check-sol-pi-config.mjs`)

`omp` distributes its runtime packages as raw TypeScript and is a Bun-only runtime; Node cannot import them.

### Install

Install the tested oh-my-pi release:

```bash
bun install --global @oh-my-pi/pi-coding-agent@18.2.0
omp --version
```

Then register this checkout with `omp`. A local path is linked, so your working copy stays the live extension source:

```bash
omp plugin link "/absolute/path/to/SoL-Pi"
omp plugin list
```

The checkout declares its entry point under `package.json#omp.extensions`, which is what the loader reads. To register it for one project only, use one of the project-local discovery mechanisms from the project directory instead of the registry:

- add the checkout to `.omp/config.yml`:

  ```yaml
  extensions:
    - /absolute/path/to/SoL-Pi
  ```

- or place or symlink the checkout under `.omp/extensions/`, for example `.omp/extensions/sol-pi`.

`omp` also reads a package manifest's `omp.extensions` array, so a checkout that declares one loads from any of these registrations. For a one-off run, load the entry file directly with `omp -e /absolute/path/to/SoL-Pi/src/sol-pi/index.ts`; `omp --no-extensions` turns off discovery while explicit `-e` paths still load.

### Configure

SoL-Pi uses a single effective configuration. It looks for a `sol-pi.json` file in the following locations, in order:

1. `.omp/sol-pi.json` in the current project;
2. `~/.omp/agent/sol-pi.json` otherwise.

If neither file exists, SoL-Pi uses its built-in defaults. The project-level configuration takes precedence over the user-level configuration; the two files are not merged.

> [!IMPORTANT]
> Upstream Pi is no longer supported. The configuration paths moved from the Pi directory to `.omp/`, so a configuration written for the previous Pi-based release — for example `~/.pi/agent/sol-pi.json` — no longer resolves, and SoL-Pi silently falls back to its defaults with every mechanism disabled. Move the file to one of the paths above. There is no automatic migration.

The following conservative configuration enables only the two local mechanisms that make no additional model calls and do not stop an active run:

```json
{
  "version": 1,
  "actionFusion": true,
  "observationPack": true,
  "evidencePreservingReducer": false,
  "onlineContextCompact": false,
  "cacheWriteReadRatio": 12.5
}
```

Enable additional mechanisms only after reviewing their configuration and security implications. SoL-Pi uses no dedicated environment variables; feature flags, the reducer provider/model route, and the compaction ratio are configured in `sol-pi.json`. See [sol-pi.example.json](sol-pi.example.json) for a template listing every key.

For the complete schema, see [Configuration](docs/configuration.md). Coding agents and automated environments should follow the canonical [agent installation and configuration protocol](agents-install.md), which describes an all-enabled configuration checked with `scripts/check-sol-pi-config.mjs --require-all-enabled`.

## Storage and Security

ObservationPack and Evidence-Preserving Reducer store session-specific archives under:

```text
<session-directory>/sol-pi/<session-id>/
├── observation-pack/
└── evidence-preserving-reducer/
```

They archive eligible source material in this directory. The archived copies remain local and are not automatically deleted when the `omp` session ends.

Online Context Compact stores its state in the host's session log. When a completed plan step selects compaction, it stops the run and requests one continuation turn that rebuilds the plan while the compaction runs. Cancelling the run or exiting `omp` does not trigger automatic continuation.

Evidence-Preserving Reducer may send eligible diagnostic-log content to its configured reducer model using `omp`-managed authentication. Review [SECURITY.md](SECURITY.md) before enabling it. Do not enable remote reduction for logs that must remain local.

## Documentation

| Document | Purpose |
|---|---|
| [Configuration](docs/configuration.md) | Config search order, schema, defaults, and project-local behavior |
| [Compatibility](docs/compatibility.md) | Supported oh-my-pi APIs and integration details |
| [Security](SECURITY.md) | Local storage, remote reduction, and sensitive behavior |
| [Agent installation](agents-install.md) | Reproducible installation and all-enabled validation procedure |

## Development

Install from the lockfile and run the complete source checks:

```bash
bun install --frozen-lockfile
bun run check
bun audit --audit-level=high
node scripts/check-omp-compat.mjs
```

`bun run check` covers TypeScript and the complete test suite. The development dependency set is pinned to oh-my-pi 18.2.0; the runtime packages remain peer dependencies so `omp` owns their installation and upgrades.

## Project Status

SoL-Pi is developed and maintained by NVIDIA as a standalone extension for oh-my-pi.

We welcome tested, oh-my-pi-compatible extension PRs that improve token efficiency and reduce token cost. Our team will help benchmark contributions, publish results on a regular reporting cycle, and credit authors of accepted PRs as Contributors. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Acknowledgements

SoL-Pi builds on the public extension interfaces provided by [oh-my-pi](https://github.com/can1357/oh-my-pi). oh-my-pi remains an independent upstream project and is not vendored into this repository. SoL-Pi no longer supports upstream Pi.

## License

SoL-Pi is released under the [MIT License](LICENSE).

## Star History

<a href="https://www.star-history.com/?repos=NVlabs%2FSoL-Pi&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/NVlabs/SoL-Pi/star-history/star-history-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/NVlabs/SoL-Pi/star-history/star-history-light.svg" />
    <img alt="SoL-Pi star history chart" src="https://raw.githubusercontent.com/NVlabs/SoL-Pi/star-history/star-history-light.svg" width="100%" />
  </picture>
</a>
