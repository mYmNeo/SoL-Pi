# Third-Party Notices

SoL-Pi does not vendor third-party source code. Its npm tarball contains only SoL-Pi source, documentation, tests-excluded assets, and project metadata.

## Runtime peer dependencies

The following packages are supplied by the user's oh-my-pi runtime and retain their own licenses:

| Package | Development-tested version | License | Source |
|---|---:|---|---|
| `@oh-my-pi/pi-agent-core` | 18.2.5 | MIT | <https://github.com/can1357/oh-my-pi> |
| `@oh-my-pi/pi-ai` | 18.2.5 | MIT | <https://github.com/can1357/oh-my-pi> |
| `@oh-my-pi/pi-coding-agent` | 18.2.5 | MIT | <https://github.com/can1357/oh-my-pi> |
| `@oh-my-pi/pi-tui` | 18.2.5 | MIT | <https://github.com/can1357/oh-my-pi> |
| `@oh-my-pi/pi-utils` | 18.2.5 | MIT | <https://github.com/can1357/oh-my-pi> |
| `@oh-my-pi/omptype` | 18.2.5 | MIT | <https://github.com/can1357/oh-my-pi> |

These packages ship raw TypeScript and are loaded by Bun; `omp` owns their installation and upgrades. `@oh-my-pi/omptype` supplies the `Type.*` schema builders used for tool parameters; `omp` also injects a TypeBox facade at `pi.typebox`, but this extension imports omptype directly.

## Development-only dependencies

`@types/bun` (MIT), `@types/node` (MIT), and TypeScript (Apache-2.0) are used to type-check the repository, and the Bun runtime runs its test suite. They are not included in the SoL-Pi npm tarball. Exact versions and transitive dependency metadata are recorded in `bun.lock`.

## Star history chart generation

The documentation workflow checks out the MIT-licensed [Star History renderer](https://github.com/star-history/star-history/tree/c326eac651bc5afb4cd40d354223dd419e1e2ae6) to preserve its chart design. Its source and dependencies are installed only for chart generation and are not included in the SoL-Pi npm tarball. The generated chart branch includes the upstream MIT license as `LICENSE-star-history.txt`.
