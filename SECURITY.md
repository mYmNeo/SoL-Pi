# Security Policy

SoL-Pi is an oh-my-pi extension. It runs with the filesystem, process, network, and credential permissions of the `omp` process that loads it. SoL-Pi is not a sandbox or permission boundary.

## Sensitive behavior

- Action Fusion can modify files and run shell commands requested by the model.
- ObservationPack stores large tool results under the host's session directory.
- Evidence-Preserving Reducer archives diagnostic logs locally and, when explicitly enabled, sends eligible logs through the configured reducer model using `omp`-managed authentication.
- The reducer skips text matching its likely-secret detector, but that detector is a precaution rather than a complete secret scanner. Do not enable remote reduction for workloads whose logs must remain local.
- Online Context Compact stores plan and compaction state in the host's session log; see below.
- Project-local `.omp/sol-pi.json` files can enable every mechanism, and `omp` performs no project-trust gating, so a project file is honored as soon as it exists. Use project-local configuration only in repositories you trust.

## Online Context Compact data

Online Context Compact is off by default. When enabled, every `update_plan` call appends a versioned custom state entry to the host's session log. The latest valid entry holds the model-authored plan, concise progress fields, request counts, token-growth estimates, and compaction debt. These values can include paths, command names, and design notes and should be treated as sensitive as the rest of the conversation. After a successful compaction, the extension also writes one hidden, generic custom message that tells the assistant to rebuild its plan; the reminder contains no task-specific data.

The extension creates no sidecar, attestation, payload-capture, or research-instrumentation files. State entries do not enter the model context; only the generic post-compaction reminder does. Deleting the `omp` session removes both kinds of persisted Online Context Compact data.

Evidence-Preserving Reducer reads the log text carried by the public `tool_result` event and copies eligible content into the session-specific archive under `<sessionDir>/sol-pi/<sessionId>/` before any nested model call. As a guarded fallback for exact bytes, it may also read a path named by the result's `fullOutputPath` detail or by an inline `Full output: <path>` marker — but only when that path is a regular, non-symlink `pi-bash-*.log` file directly inside the operating system's temporary directory. oh-my-pi 18.2.5 produces no such files (its bash tool does not spill oversized output to the temp directory), so this branch is a bounded legacy guard rather than a live source.

## Reporting a vulnerability

Use the repository's GitHub Security Advisories page to submit a private report. Do not open a public issue for a suspected vulnerability.

Include the affected commit or version, configuration, impact, reproduction steps, and any available mitigation. Reports about `omp` itself should be sent to the upstream oh-my-pi project.
