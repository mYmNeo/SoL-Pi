# Contributing

We welcome external pull requests that improve token efficiency and reduce token cost through oh-my-pi-compatible extensions.

## Pull Request Requirements

Your PR should:

- Implement an oh-my-pi-compatible extension using oh-my-pi's public extension APIs, without modifying `omp`'s core.
- Be tested before submission, with relevant automated tests and reproducible validation steps.
- Clearly explain how the extension reduces token cost or improves token efficiency, including local measurements where available.
- Document its configuration, expected behavior, and any trade-offs. Efficiency improvements will be evaluated alongside correctness and task performance.

## Benchmarking and Reports

Our team will help benchmark submitted extensions to evaluate token usage, model cost, and task performance.

We will publish updated benchmark reports on a regular reporting cycle, sharing evaluated changes, results, and any observed trade-offs.

## Contributor Recognition

Authors of accepted PRs will be credited as Contributors in the project documentation and the relevant benchmark reports.
