# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - Initial Release

Initial public release of `agent-loop-guard`.

This release introduces a lightweight, framework-independent guard layer for detecting runaway LLM agent loops before they waste execution time, tokens, and API budget.

### Added

- `LoopGuard` class for monitoring agent tool-call execution.
- `beforeCall()` and `afterCall()` hooks for integrating with existing agent loops.
- `summary()` for execution statistics and `reset()` for reusing guard instances.
- Configurable call-budget enforcement through `maxCalls`.
- Repeated tool-call detection through `repeatThreshold`.
- Stagnant result detection through `stagnationThreshold`.
- Multi-step cycle detection through `maxCycleLength` and `cycleThreshold`.
- Structured decision responses with:
  - decision codes
  - suggested actions
  - actionable feedback
- Deterministic call and result signatures using:
  - `callSignature`
  - `stableStringify`
  - `hashSignature`
- Custom signature hooks through:
  - `signature`
  - `resultSignature`
- Observability support through the `onDecision` callback.
- TypeScript declarations for the complete public API.
- ESM support for Node.js 18+.
- Zero runtime dependencies.

### Security and Reliability

- Cycle-safe serialization to handle circular references.
- Bounded signature storage using SHA-256 hashing for oversized signatures.
- Validation of configuration values to prevent unsafe runtime behavior.
- Protection against ambiguous serialization cases.
- Controlled cycle detection limits to keep runtime costs predictable.

### Compatibility

- Node.js 18, 20, 22, and 24.
- TypeScript projects using modern ESM / NodeNext module resolution.
- npm package installation with ESM consumers.

### Notes

This is the first public release. The API is considered stable for early adoption, but future `0.x` releases may introduce improvements based on real-world usage and feedback.

[0.1.0]: https://github.com/nextbridgehq/agent-loop-guard/releases/tag/v0.1.0