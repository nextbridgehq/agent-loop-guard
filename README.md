# agent-loop-guard

[![npm version](https://img.shields.io/npm/v/agent-loop-guard)](https://www.npmjs.com/package/agent-loop-guard)
[![CI](https://github.com/nextbridgehq/agent-loop-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/nextbridgehq/agent-loop-guard/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
![dependencies](https://img.shields.io/badge/dependencies-zero-success)



Developed and open-sourced by [Nextbridge](https://www.nextbridge.com).

---

**LLM agent loop detection for JavaScript, TypeScript, and Node.js.** `agent-loop-guard` is a lightweight AI agent guard for autonomous agents: a decision layer that delivers tool-call loop prevention by watching for repeated tool calls, stagnant results, and multi-step cycles before an agent burns its budget. Cycle detection and agent safety checks run entirely in-process — no framework, model client, or tool executor required.

`agent-loop-guard` doesn't execute tools or wrap a model client — it's two function calls, `beforeCall()` and `afterCall()`, that you check around your own tool-execution code. Every blocked decision comes back with a concrete, actionable suggestion instead of just a boolean, so it drops into any Node.js agent loop in minutes.

---

## Contents

- [The Problem](#the-problem)
- [Quick Start](#quick-start)
- [Features](#features)
- [Why & Who It's For](#why--who-its-for)
- [Installation](#installation)
- [Usage](#usage)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Example output](#example-output)
- [Decision codes](#decision-codes)
- [Programmatic API](#programmatic-api)
- [TypeScript support](#typescript-support)
- [How it works](#how-it-works)
- [Limitations](#limitations)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Changelog](CHANGELOG.md)
- [Contributing](#contributing)
- [License](#license)

## The Problem

Modern AI agents can run in loops without realizing it:

```
Agent:
  → search("customer record")
  → search("customer record")
  → search("customer record")
  → search("customer record")
```

A simple `maxIterations` limit stops the runaway cost, but it doesn't explain:

- Why did the agent get stuck?
- Which tool call caused the loop?
- Did the result stop changing?
- What should the agent try next?

`agent-loop-guard` adds a decision layer around your existing tool-execution loop: it detects the pattern early and hands back structured, actionable feedback instead of only saying "stop."

## Quick Start

```bash
npm install agent-loop-guard
```

```js
import { LoopGuard } from "agent-loop-guard";

const guard = new LoopGuard();
const decision = guard.beforeCall("search", { query: "cats" });

if (!decision.allowed) {
  console.log(decision.suggestionDetail);
}
```

See [Usage](#usage) for a full agent loop wired up with `beforeCall()` and `afterCall()`.

## Features

- **Call-budget enforcement** — a hard ceiling (`maxCalls`) on total tool calls per run, so a runaway loop can't spend unbounded time or API cost.
- **Repeated-call detection** — flags the same tool called with identical arguments `repeatThreshold` times in a row.
- **Consecutive stagnation detection** — flags the same call returning the same result `stagnationThreshold` times in a row.
- **Cycle detection** — detects when an agent alternates between the same sequences of calls and results (e.g. A B C A B C) without progressing.
- **Actionable agent feedback** — every blocked decision carries a programmatic `code`, a `suggestedAction` (`"stop"` or `"change_approach"`), and a plain-English `suggestionDetail` you can feed straight back into the agent's next prompt turn.
- **Deterministic, cycle-safe signatures** — call arguments and results are serialized using a stable stringifier that handles `Date`, typed arrays, `BigInt`, and circular references consistently. Signatures exceeding `maxSignatureLength` are hashed using SHA-256.
- **Framework-independent** — pure decision logic with no dependency on any particular agent runtime, model client, or tool-calling format.
- **Bounded signature memory** — `maxSignatureLength` collapses oversized signatures to a short hash before they're retained, so pathologically large arguments don't bloat guard state.
- **Zero runtime dependencies**, with TypeScript declarations for the [Programmatic API](#programmatic-api).

## Why & Who It's For

Agent harnesses that let a model call tools in a loop — Claude Code-style runtimes, custom agent frameworks, anything built around a `while` loop and a tool dispatcher — can get stuck without any of the individual steps looking obviously wrong. `agent-loop-guard` exists to catch that pattern early and hand back a next step, rather than letting the loop spin until a timeout or budget cutoff kills it.

Use it if you're building or operating a Node.js agent runtime and want tool-calling loop prevention and agent stagnation detection without adopting a specific agent framework; if you want Node.js agent reliability guardrails that are easy to unit test in isolation; or if you want blocked-call feedback that's already phrased for a model, not just a boolean.

**Why not just use max iterations?**

| Approach            | Stops runaway loops | Explains cause | Framework independent |
| ------------------- | -------------------- | --------------- | ---------------------- |
| Max iterations      | ✅                    | ❌               | ✅                      |
| Timeout             | ✅                    | ❌               | ✅                      |
| `agent-loop-guard`  | ✅                    | ✅               | ✅                      |

A hard limit protects your budget. `agent-loop-guard` also helps your agent understand what happened and choose a better next action.

## Installation

```bash
npm install agent-loop-guard
```

Requires **Node.js >= 18**. `agent-loop-guard` is ESM-only (`import`, not `require()`), matching its `package.json` `type: "module"` and `engines` field. Zero runtime dependencies.

**Using it from CommonJS:** `require("agent-loop-guard")` is intentionally unsupported — the package's `exports` map only declares an `import` condition, so `require()` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` regardless of Node version. A CommonJS file can still consume the package via dynamic `import()`, which works on all supported Node versions:

```js
// consumer.cjs
(async () => {
  const { LoopGuard } = await import("agent-loop-guard");
  const guard = new LoopGuard();
  // ...
})();
```

## Usage

```js
import { LoopGuard } from "agent-loop-guard";

const guard = new LoopGuard({
  maxCalls: 50,
  repeatThreshold: 3,
  stagnationThreshold: 2,
});

for (const step of agentSteps) {
  const pre = guard.beforeCall(step.tool, step.args);
  if (!pre.allowed) {
    // budget exhausted, or this call would repeat too many times in a row
    break;
  }

  const result = await callTool(step.tool, step.args);

  const post = guard.afterCall(step.tool, step.args, result);
  if (!post.allowed) {
    // Budget exhausted, stagnant result, or repeated multi-step cycle.
    break;
  }
}

console.log(guard.summary());
```

Feed a blocked decision's `suggestionDetail` back into the conversation instead of aborting silently:

```js
if (!post.allowed) {
  messages.push({
    role: "user",
    content: `System note: ${post.suggestionDetail}`,
  });
}
```

## Architecture

``` text
Agent Runtime
      |
      v
beforeCall()
      |
      +---- allowed ----> Tool execution
      |
      +---- blocked ----> Guidance
                         |
                         v
                    Agent decides

Tool result
      |
      v
afterCall()
      |
      v
Loop detection
```

## Configuration

```js
new LoopGuard(options?)
```

| Option                | Default  | Description                                                                                                                                                                                |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `maxCalls`            | `50`     | Hard ceiling on total tool calls in a session.                                                                                                                                             |
| `repeatThreshold`     | `3`      | Consecutive identical calls (same tool + args) before blocking. Minimum `2`.                                                                                                               |
| `stagnationThreshold` | `2`      | Consecutive identical call+result pairs before flagging stagnation. Minimum `2`.                                                                                                           |
| `maxSignatureLength`  | `200000` | Signatures longer than this are hashed down before being retained in guard history. Values are still fully serialized first, so this bounds stored-signature size, not serialization time. |
| `maxCycleLength`      | `0`      | Max sequence length to track for cycle detection (0 = disabled). Maximum `1000` — see note below.                                                                                          |
| `cycleThreshold`      | `2`      | How many times a sequence must repeat to be flagged. Minimum `2`.                                                                                                                          |
| `signature`           | `null`   | Optional custom call signature function: `(toolName, args) => string`.                                                                                                                     |
| `resultSignature`     | `null`   | Optional custom result signature function: `(result) => string`.                                                                                                                           |
| `onDecision`          | `null`   | Optional observability hook: `(decision) => void`. Triggered on all `beforeCall` and `afterCall` decisions.                                                                                |

`maxCalls` and `maxSignatureLength` must be positive integers. `maxCycleLength` must be `0` or an integer `≥ 2` and `≤ 1000`. Option thresholds (`repeatThreshold`, `stagnationThreshold`, `cycleThreshold`) must be integers `≥ 2`. Hooks can be functions or `null`. An unrecognized key or an out-of-range value throws a `TypeError` from the constructor.

`onDecision` is intended for observability only. If it throws, the error is ignored so logging or metrics failures do not crash the agent loop. To keep in-flight decisions stable, the same `LoopGuard` instance rejects `beforeCall()`, `afterCall()`, and `reset()` calls made from inside its own `onDecision` callback with a clear `Error`. A callback may still interact with a different `LoopGuard` instance.

> **Larger cycle windows cost more.** Cycle detection re-scans the retained call-history window on every `afterCall()`, at roughly `O(maxCycleLength² × cycleThreshold)` cost per call. Measured steady-state cost per call scales from ~0.03ms at `maxCycleLength: 10` to ~0.24ms at `maxCycleLength: 1000` to ~8ms at `maxCycleLength: 5000` — cost roughly quadruples as `maxCycleLength` doubles. `1000` is enforced as a hard ceiling to keep this bounded; pick the smallest `maxCycleLength` that covers the sequence lengths you actually expect to see in a stuck agent.

### Production payload guidance

`maxSignatureLength` limits the size of signatures retained in guard state, but the default serializer still has to inspect and serialize the full value before it can decide whether to hash it. Avoid passing unrestricted large or untrusted payloads directly as tool arguments or results. This is especially important for raw API responses, large buffers, deeply nested documents, user-controlled objects, or objects from unknown realms.

For production agents, prefer custom `signature` and `resultSignature` functions that select bounded, stable identifiers or fields that actually matter for loop detection:

```js
const guard = new LoopGuard({
  signature(toolName, args) {
    return JSON.stringify({
      toolName,
      accountId: args.accountId,
      requestKind: args.requestKind,
      pageToken: args.pageToken ?? null,
    });
  },
  resultSignature(result) {
    return JSON.stringify({
      status: result.status,
      nextPageToken: result.nextPageToken ?? null,
      itemCount: Array.isArray(result.items) ? result.items.length : null,
    });
  },
});
```

Do not include timestamps, random IDs, raw response bodies, or full document contents unless those values are truly part of the loop identity. Also note that JavaScript `Proxy` traps may execute during default signature inspection because object keys and property descriptors must be read to reject ambiguous values safely.

## Example output

A blocked `beforeCall()` decision after three identical `read_file` calls in a row:

```js
{
  allowed: false,
  code: 'REPEATED_CALL',
  reason: '"read_file" has been called with identical arguments 3 times in a row. The agent appears stuck in a loop.',
  suggestedAction: 'change_approach',
  suggestionDetail: 'Do not retry "read_file" with the same arguments. Either try different arguments, use a different tool to accomplish the same goal, or ask the user for clarification if the task is ambiguous.'
}
```

A clean `afterCall()` decision:

```js
{ allowed: true, code: 'OK', stagnant: false, reason: null, suggestedAction: null, suggestionDetail: null }
```

## Decision codes

Every decision returned by `beforeCall()` and `afterCall()` carries one of these `code` values:

| Code | Meaning | Returned from |
| --- | --- | --- |
| `OK` | The call is allowed — no loop pattern was detected. | `beforeCall()`, `afterCall()` |
| `BUDGET_EXHAUSTED` | The total call budget (`maxCalls`) has been used up for this run. | `beforeCall()`, `afterCall()` |
| `REPEATED_CALL` | The same tool has been called with identical arguments `repeatThreshold` times in a row. | `beforeCall()` |
| `STAGNANT_RESULT` | The same call has returned the same result `stagnationThreshold` times in a row — no progress is being made. | `afterCall()` |
| `CYCLE_DETECTED` | A repeating multi-step sequence of calls and results has repeated `cycleThreshold` times in a row. | `afterCall()` |

## Programmatic API

### `new LoopGuard(options?)`

Creates a guard instance. See [Configuration](#configuration) for the accepted options.

### `guard.beforeCall(toolName, args)` → `BeforeCallDecision`

Call before executing a tool. Checks the call budget, then whether this would be the Nth consecutive identical call.

### `guard.afterCall(toolName, args, result)` → `AfterCallDecision`

Call after executing a tool, passing its result. Records the call, updates counters, and checks for a repeating call+result stagnation or a repeating multi-step cycle pattern.

### `guard.summary()` → `LoopGuardSummary`

Returns `{ totalCalls, uniqueCallSignatures, budgetRemaining }` — useful for logging at the end of a run.

### `guard.reset()` → `void`

Clears all call history and counters so the same instance can be reused for a new run.

### `callSignature(toolName, args)`, `stableStringify(value)`, `hashSignature(input)`

The deterministic serialization primitives `LoopGuard` is built on, exported for advanced use — e.g. building a custom stagnation check outside of `LoopGuard` itself.

## TypeScript support

Type declarations ship in [`src/index.d.ts`](src/index.d.ts) and are resolved automatically via the package's `types` field — no separate `@types` package needed.

```ts
import type {
  LoopGuardOptions,
  GuardDecision,
  SuggestedAction,
  LoopGuardSummary,
} from "agent-loop-guard";
```

| Export                                                                     | Kind      | Notes                                                                |
| -------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------- |
| `LoopGuard`                                                                | class     | See [Programmatic API](#programmatic-api).                           |
| `callSignature`, `stableStringify`, `hashSignature`                        | functions | Serialization primitives; see [Programmatic API](#programmatic-api). |
| `LoopGuardOptions`, `GuardDecision`, `SuggestedAction`, `LoopGuardSummary` | types     | Public shapes for the API above.                                     |

> **Note:** call arguments and results follow different rules once serialized. Arguments passed to `beforeCall()` / `afterCall()` must fit the supported-value set below or the call throws a `TypeError`. Results passed to `afterCall()` are more forgiving — an unsupported result value (a function, `Map`, etc.) falls back to a stable per-guard identity signature instead of throwing.

**Supported values:** strings, booleans, numbers (`NaN`, `Infinity`, `-Infinity`, and `-0` are each encoded distinctly), `null`, `undefined`, `bigint`, plain objects and class instances (including non-enumerable own data properties), arrays (empty, sparse, and explicit-`undefined` elements are all distinguished), valid `Date` instances, typed arrays, `ArrayBuffer`, `URL`, `URLSearchParams`, and circular/self-referential structures.

**Rejected values** (throws `TypeError`): functions, symbols, symbol-keyed properties on ordinary objects (symbol-keyed state on supported built-ins is ignored), accessor properties — getters/setters are never invoked, even to reject them — `Map`, `Set`, `DataView`, invalid `Date` values, and nesting deeper than 100 levels. Unsupported native built-ins not explicitly listed as supported are also rejected.

## How it works

1. `beforeCall()` checks the call budget first, then whether the upcoming call would be the Nth consecutive identical call (same tool + arguments).
2. `afterCall()` records the call, computes a signature for the result, and checks whether the same call+result pair has now repeated `stagnationThreshold` times in a row, or if a longer sequence of call+result pairs has formed a cycle.
3. Both signatures come from `callSignature()`, a deterministic, cycle-safe serializer — identical inputs always produce identical signatures, regardless of key order or object identity.
4. A blocked decision from either method carries a `suggestedAction` and `suggestionDetail`, so the caller has a concrete next step rather than just a boolean.
5. `summary()` and `reset()` let you inspect and reuse a guard instance across runs without constructing a new one.

## Limitations

- In-memory, single-run state — nothing is persisted across process restarts, and a single `LoopGuard` instance isn't safe to share across concurrent runs unless you add that coordination yourself.
- It doesn't call tools, wrap a model client, or fix the loop for you (no retries, no backtracking) — it only tells you when to make that decision.
- Call arguments must serialize under the supported-value rules in [TypeScript support](#typescript-support); tool arguments that legitimately include functions, symbols, `Map`s, or `Set`s will throw rather than being silently approximated.
- Different user-defined classes with the same constructor name and identical own properties generate identical signatures. This is acceptable for most JSON-style tool arguments, but custom signature hooks can be used if stricter object-identity tracking is required.

## Security

`agent-loop-guard` has zero runtime dependencies and makes no network requests or file-system access of its own — it only inspects and serializes the tool names, arguments, and results you pass into `beforeCall()` / `afterCall()`. There is no telemetry and no external calls of any kind.

The main security-relevant surface is signature serialization itself: see [Production payload guidance](#production-payload-guidance) above for how to avoid passing unrestricted large or untrusted payloads directly as tool arguments or results, and the [rejected-values list](#typescript-support) for which value shapes are refused outright rather than serialized ambiguously.

To report a security issue, open an issue at the [repository's issue tracker](https://github.com/nextbridgehq/agent-loop-guard/issues).

## Troubleshooting

**`beforeCall()` or `afterCall()` throws a `TypeError` about an unsupported value.**
One of the tool arguments contains a function, symbol, `Map`, `Set`, `DataView`, or an accessor property (getter/setter). These are rejected rather than serialized ambiguously — see the rejected-values list in [TypeScript support](#typescript-support). This only applies to arguments; unsupported _results_ fall back to an identity signature instead of throwing.

**`repeatThreshold` isn't blocking a loop I can see happening.**
Repeats must be _consecutive_ — a single different call in between resets the counter. Check that the arguments are actually identical after serialization (e.g. object key order doesn't matter, but a differing timestamp or request ID in the arguments will).

**The guard's counts look wrong after a burst of calls.**
Call `guard.summary()` to inspect `totalCalls`, `uniqueCallSignatures`, and `budgetRemaining` directly, and confirm you're calling `afterCall()` — not just `beforeCall()` — for every executed call, since only `afterCall()` updates history.

## FAQ

**Does `agent-loop-guard` call my tools or my model for me?**
No — it's a pure decision layer. You call `beforeCall()` / `afterCall()` around your own tool-execution code.

**Does it work with LangChain, OpenAI, Claude, or other frameworks?**
Yes — it has no dependency on a specific agent runtime, model provider, or tool-calling format. Pass a tool name and its arguments; that's the whole contract.

**Does it try to fix a detected loop automatically?**
No — see [Limitations](#limitations). It flags the pattern and returns a suggestion; retrying with different arguments, switching tools, or asking the user is left to your agent's control loop.

## Contributing

Issues and pull requests are welcome.

1. Fork the repository.
2. Create a feature branch:

   ```bash
   git checkout -b feature/my-change
   ```

3. Run checks:

   ```bash
   npm run check
   ```

4. Open a pull request describing your change.

## License

[MIT](LICENSE) © [Nextbridge](https://www.nextbridge.com)

---

Built and maintained by **[Nextbridge](https://www.nextbridge.com)**

[GitHub](https://github.com/nextbridgehq/agent-loop-guard) · [npm](https://www.npmjs.com/package/agent-loop-guard) · [Issues](https://github.com/nextbridgehq/agent-loop-guard/issues) · [Changelog](CHANGELOG.md)

If this project helps you build safer AI agents, consider giving it a ⭐ on [GitHub](https://github.com/nextbridgehq/agent-loop-guard).

