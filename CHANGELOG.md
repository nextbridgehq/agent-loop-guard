# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-07

Focused on the two things 0.1.0 users hit first: loops that consecutive-repeat detection can't see, and integrations where `beforeCall()` and `afterCall()` drift apart.

Backward compatible with 0.1.0 — every new option defaults to the previous behavior. The only change to existing decision objects is an added `warnings` array, which is empty unless a threshold is being approached.

### Added

- `run(toolName, args, executor)` — wraps `beforeCall()` → executor → `afterCall()` in one awaited call, returning a structured outcome instead of two decisions you have to pair yourself.
- `afterError(toolName, args, error)` — records a thrown error the way `afterCall()` records a result, so a tool that keeps failing identically is caught as stagnation. Configurable through the new `errorSignature` option.
- Per-tool call budgets through `maxCallsPerTool`, with the new `TOOL_BUDGET_EXHAUSTED` decision code. Exhausting one tool no longer has to end the run.
- Wall-clock budgets through `maxDurationMs`, with the new `TIME_BUDGET_EXHAUSTED` decision code. The clock starts at the first call, not at construction, and can be overridden for testing with the new `now` option.
- Windowed repeat detection through `windowSize` and `maxRepeatsInWindow`, with the new `REPEATED_CALL_IN_WINDOW` decision code — catches the same call recurring inside a sliding window even when other calls are interleaved between the repeats.
- Non-blocking early warnings on every decision (`decision.warnings`): `APPROACHING_BUDGET`, `APPROACHING_TOOL_BUDGET`, `APPROACHING_REPEAT_LIMIT`, and `APPROACHING_STAGNATION`. Controlled by the new `warn` and `budgetWarnAt` options.
- State persistence through `toJSON()` and `LoopGuard.fromJSON(state, options)` — a guard's run state can now survive a process restart. Elapsed time is stored as a duration, so time budgets restore correctly against a different clock.
- `report()` — renders the current run state as a short plain-text block suitable for feeding back into a model's context.
- TypeScript declarations for the new surface: `RunOutcome`, `GuardWarning`, `WarningCode`, `LoopGuardState`, `BeforeCallBlockCode`, `AfterCallBlockCode`.

### Changed

- `summary()` now also reports `blockedCalls`, `elapsedMs`, `callsByTool`, and `decisionsByCode` alongside the existing fields.
- Every decision object now carries a `warnings` array (empty when nothing is approaching a threshold).
- Option validation is driven by a single option spec table, giving consistent messages for range, type, and cross-option errors (`maxRepeatsInWindow` may not exceed `windowSize`).
- Stagnation messaging distinguishes repeated results from repeated failures.

### Notes

- `LoopGuard` is still not safe to share across concurrent runs — including parallel `run()` calls on the same instance.
- `toJSON()` includes the set of unique call signatures, so snapshot size grows with the number of distinct calls in a run. Pair persistence with a custom `signature` function for long runs with large arguments.

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
[0.2.0]: https://github.com/nextbridgehq/agent-loop-guard/releases/tag/v0.2.0
