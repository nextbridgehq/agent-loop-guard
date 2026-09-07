import { callSignature, hashSignature } from "./signature.js";

const DEFAULT_OPTIONS = {
  maxCalls: 50,             // hard ceiling on total tool calls in a session
  maxCallsPerTool: null,    // optional per-tool ceilings: { toolName: maxCalls }
  maxDurationMs: 0,         // wall-clock ceiling for a run (0 = disabled)
  repeatThreshold: 3,       // consecutive identical calls (same tool+args) before flagging
  stagnationThreshold: 2,   // identical (tool+args+result) pairs before flagging "no progress"
  windowSize: 0,            // sliding window of recent calls for non-consecutive repeats (0 = disabled)
  maxRepeatsInWindow: 3,    // identical calls allowed within the window before flagging
  maxSignatureLength: 200_000, // signatures longer than this are hashed down before storage
  maxCycleLength: 0,        // max sequence length to track for cycle detection (0 = disabled, max 1000 — see MAX_CYCLE_LENGTH)
  cycleThreshold: 2,        // how many times a sequence must repeat to be flagged
  warn: true,               // emit non-blocking early warnings on decisions
  budgetWarnAt: 5,          // warn when this many calls (or fewer) remain in a budget (0 = disabled)
  signature: null,          // optional custom call signature function
  resultSignature: null,    // optional custom result signature function
  errorSignature: null,     // optional custom error signature function
  onDecision: null,         // optional observability hook: (decision) => void
  now: null,                // optional clock override: () => number (ms). Defaults to Date.now
};

function validateToolName(toolName) {
  if (typeof toolName !== "string" || toolName.length === 0) {
    throw new TypeError("toolName must be a non-empty string.");
  }
}

function sameCycleEntry(left, right) {
  return (
    left.callSignature === right.callSignature &&
    left.resultSignature === right.resultSignature
  );
}

const MIN_REPEAT_THRESHOLD = 2;
const MIN_STAGNATION_THRESHOLD = 2;
const MIN_CYCLE_THRESHOLD = 2;

// Cycle detection re-scans the retained call-history window on every afterCall(),
// at O(maxCycleLength^2 * cycleThreshold) cost. 1000 keeps steady-state cost per
// call under ~0.25ms (measured), which stays negligible even across an agent run
// of thousands of calls, while comfortably covering realistic loop lengths. See
// the README's Configuration section for the measured cost table.
const MAX_CYCLE_LENGTH = 1000;

// Windowed repeat detection is a single linear scan of the retained window on
// every beforeCall() — O(windowSize) — so it tolerates a much larger ceiling
// than cycle detection.
const MAX_WINDOW_SIZE = 10_000;

const STATE_VERSION = 1;

// Option specs drive constructor validation. `min` is the smallest accepted
// positive value; `allowZero` marks options where 0 means "disabled".
const OPTION_SPECS = {
  maxCalls: { kind: "integer", min: 1 },
  maxCallsPerTool: { kind: "toolBudgets" },
  maxDurationMs: { kind: "integer", min: 1, allowZero: true },
  repeatThreshold: { kind: "integer", min: MIN_REPEAT_THRESHOLD },
  stagnationThreshold: { kind: "integer", min: MIN_STAGNATION_THRESHOLD },
  windowSize: { kind: "integer", min: 2, allowZero: true, max: MAX_WINDOW_SIZE },
  maxRepeatsInWindow: { kind: "integer", min: 2 },
  maxSignatureLength: { kind: "integer", min: 1 },
  maxCycleLength: { kind: "integer", min: 2, allowZero: true, max: MAX_CYCLE_LENGTH },
  cycleThreshold: { kind: "integer", min: MIN_CYCLE_THRESHOLD },
  warn: { kind: "boolean" },
  budgetWarnAt: { kind: "integer", min: 1, allowZero: true },
  signature: { kind: "function" },
  resultSignature: { kind: "function" },
  errorSignature: { kind: "function" },
  onDecision: { kind: "function" },
  now: { kind: "function" },
};

function defaultErrorSignature(error) {
  if (error instanceof Error) {
    const code = error.code === undefined ? "" : String(error.code);
    return `$error:${error.name}:${code}:${String(error.message).slice(0, 500)}`;
  }
  try {
    return `$error:value:${callSignature("error", error)}`;
  } catch {
    return `$error:unserializable:${typeof error}`;
  }
}

/**
 * LoopGuard tracks an agent's tool-calling history within a single run
 * and flags patterns that indicate the agent is stuck: calling the same
 * tool with the same args repeatedly, getting the same result (or the
 * same error) back without making progress, or cycling between the same
 * sequence of steps.
 *
 * It does not call tools itself — it's a pure decision layer you check
 * before and after each tool call, or wrap around one with run().
 */
export class LoopGuard {
  #deliveringDecision = false;

  constructor(options = {}) {
    validateOptions(options);
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.clock = typeof this.options.now === "function" ? this.options.now : Date.now;
    this.#initState();
  }

  #initState() {
    this.totalCalls = 0;
    this.uniqueSignatures = new Set();
    this.consecutiveRepeatCount = 0;
    this.lastSignature = null;
    this.lastResultCallSignature = null;
    this.lastResultSignature = null;
    this.consecutiveResultCount = 0;
    this.unsupportedObjectIds = new WeakMap();
    this.unsupportedSymbolIds = new Map();
    this.nextUnsupportedId = 1;
    this.callHistory = [];
    this.recentSignatures = [];
    this.callsByTool = new Map();
    this.decisionsByCode = Object.create(null);
    this.blockedCalls = 0;
    this.startedAt = null;
  }

  #assertNotDeliveringDecision(methodName) {
    if (this.#deliveringDecision) {
      throw new Error(
        `LoopGuard ${methodName}() cannot be called from the same instance while onDecision is running.`
      );
    }
  }

  #decision(result) {
    this.decisionsByCode[result.code] = (this.decisionsByCode[result.code] ?? 0) + 1;
    if (!result.allowed) {
      this.blockedCalls += 1;
    }
    if (typeof this.options.onDecision === "function") {
      this.#deliveringDecision = true;
      try {
        this.options.onDecision(
          Object.freeze({ ...result, warnings: Object.freeze([...result.warnings]) })
        );
      } catch (err) {
        // Ignore observability errors to prevent crashing the agent loop
      } finally {
        this.#deliveringDecision = false;
      }
    }
    return result;
  }

  /** Starts the wall-clock window on the first observed call. */
  #touchClock() {
    if (this.startedAt === null) {
      this.startedAt = this.clock();
    }
  }

  #elapsedMs() {
    return this.startedAt === null ? 0 : Math.max(0, this.clock() - this.startedAt);
  }

  #toolBudget(toolName) {
    const budgets = this.options.maxCallsPerTool;
    if (budgets === null || !Object.hasOwn(budgets, toolName)) return null;
    return budgets[toolName];
  }

  #budgetWarnings(toolName, warnings) {
    const warnAt = this.options.budgetWarnAt;
    if (!this.options.warn || warnAt === 0) return warnings;

    const remaining = Math.max(0, this.options.maxCalls - this.totalCalls);
    if (remaining > 0 && remaining <= warnAt) {
      warnings.push({
        code: "APPROACHING_BUDGET",
        message: `${remaining} of ${this.options.maxCalls} tool calls remain in this run. Prioritize the steps that actually finish the task.`,
      });
    }

    const toolBudget = this.#toolBudget(toolName);
    if (toolBudget !== null) {
      const used = this.callsByTool.get(toolName) ?? 0;
      const toolRemaining = Math.max(0, toolBudget - used);
      if (toolRemaining > 0 && toolRemaining <= warnAt) {
        warnings.push({
          code: "APPROACHING_TOOL_BUDGET",
          message: `${toolRemaining} of ${toolBudget} calls to "${toolName}" remain. Consider a different tool for the remaining steps.`,
        });
      }
    }

    return warnings;
  }

  /**
   * Call this BEFORE executing a tool call. Returns whether the call
   * should be allowed to proceed.
   */
  beforeCall(toolName, args) {
    this.#assertNotDeliveringDecision("beforeCall");
    validateToolName(toolName);
    this.#touchClock();

    if (this.totalCalls >= this.options.maxCalls) {
      return this.#decision({
        allowed: false,
        code: "BUDGET_EXHAUSTED",
        reason: `Call budget exhausted (${this.totalCalls}/${this.options.maxCalls} calls used).`,
        suggestedAction: "stop",
        suggestionDetail: "End the run and surface a summary to the user rather than continuing — the budget exists to prevent runaway cost/time, not to be silently raised.",
        warnings: [],
      });
    }

    if (this.options.maxDurationMs > 0) {
      const elapsed = this.#elapsedMs();
      if (elapsed >= this.options.maxDurationMs) {
        return this.#decision({
          allowed: false,
          code: "TIME_BUDGET_EXHAUSTED",
          reason: `Time budget exhausted (${elapsed}ms elapsed of ${this.options.maxDurationMs}ms allowed).`,
          suggestedAction: "stop",
          suggestionDetail: "The run has taken longer than its allotted wall-clock budget. Stop and report what was accomplished, including what remains unfinished.",
          warnings: [],
        });
      }
    }

    const toolBudget = this.#toolBudget(toolName);
    if (toolBudget !== null && (this.callsByTool.get(toolName) ?? 0) >= toolBudget) {
      return this.#decision({
        allowed: false,
        code: "TOOL_BUDGET_EXHAUSTED",
        reason: `Per-tool budget exhausted for "${toolName}" (${toolBudget}/${toolBudget} calls used).`,
        suggestedAction: "change_approach",
        suggestionDetail: `"${toolName}" has used its entire call budget for this run. Use a different tool, work with what it already returned, or ask the user how to proceed.`,
        warnings: [],
      });
    }

    const signature = this.#boundedSignature(toolName, args);
    const projectedRepeats =
      signature === this.lastSignature ? this.consecutiveRepeatCount + 1 : 1;

    if (projectedRepeats >= this.options.repeatThreshold) {
      return this.#decision({
        allowed: false,
        code: "REPEATED_CALL",
        reason: `"${toolName}" has been called with identical arguments ${projectedRepeats} times in a row. The agent appears stuck in a loop.`,
        suggestedAction: "change_approach",
        suggestionDetail: `Do not retry "${toolName}" with the same arguments. Either try different arguments, use a different tool to accomplish the same goal, or ask the user for clarification if the task is ambiguous.`,
        warnings: [],
      });
    }

    if (this.options.windowSize > 0) {
      let occurrences = 0;
      for (const recent of this.recentSignatures) {
        if (recent === signature) occurrences += 1;
      }
      const projected = occurrences + 1;
      if (projected >= this.options.maxRepeatsInWindow) {
        return this.#decision({
          allowed: false,
          code: "REPEATED_CALL_IN_WINDOW",
          reason: `"${toolName}" has been called with identical arguments ${projected} times within the last ${this.recentSignatures.length + 1} calls. The agent keeps circling back to the same call instead of progressing.`,
          suggestedAction: "change_approach",
          suggestionDetail: `Interleaving other calls between repeats of "${toolName}" with these arguments hasn't produced new information. Change the arguments, switch tools, or summarize what's known and ask the user for direction.`,
          warnings: [],
        });
      }
    }

    const warnings = this.#budgetWarnings(toolName, []);
    // Only warn when there is headroom left: with repeatThreshold 2 the second
    // identical call is already blocked, so an "approaching" warning is noise.
    if (this.options.warn && projectedRepeats >= 2 && projectedRepeats >= this.options.repeatThreshold - 1) {
      warnings.push({
        code: "APPROACHING_REPEAT_LIMIT",
        message: `"${toolName}" has been called with identical arguments ${projectedRepeats} time(s) in a row. One more identical call will be blocked — change the arguments or the approach.`,
      });
    }

    return this.#decision({
      allowed: true,
      code: "OK",
      reason: null,
      suggestedAction: null,
      suggestionDetail: null,
      warnings,
    });
  }

  /**
   * Call this AFTER executing a tool call, passing the result. Updates
   * internal history and returns whether budget is exhausted, a stagnation
   * pattern was detected (same call + same result repeating), or a
   * multi-step cycle was detected.
   */
  afterCall(toolName, args, result) {
    this.#assertNotDeliveringDecision("afterCall");
    validateToolName(toolName);
    return this.#record(toolName, args, () => this.#safeResultSignature(result), "result");
  }

  /**
   * Call this AFTER a tool call that threw, passing the error. Records the
   * failure the same way afterCall() records a result, so an agent retrying
   * a tool that keeps failing identically is caught as stagnation instead of
   * running until the budget is gone.
   */
  afterError(toolName, args, error) {
    this.#assertNotDeliveringDecision("afterError");
    validateToolName(toolName);
    return this.#record(toolName, args, () => this.#boundedErrorSignature(error), "error");
  }

  /**
   * Runs a tool through the guard: beforeCall() → executor() → afterCall()
   * (or afterError() if the executor throws), so the two halves can never
   * drift out of sync.
   *
   * Returns an outcome object whether the call was allowed or blocked. If the
   * executor throws, the failure is recorded and the error is re-thrown with
   * the resulting decision attached as `error.loopGuardDecision`.
   */
  async run(toolName, args, executor) {
    if (typeof executor !== "function") {
      throw new TypeError("run() requires an executor function.");
    }

    const before = this.beforeCall(toolName, args);
    if (!before.allowed) {
      return {
        executed: false,
        blocked: true,
        phase: "before",
        decision: before,
        before,
        after: null,
        result: undefined,
      };
    }

    let result;
    try {
      result = await executor();
    } catch (error) {
      const failed = this.afterError(toolName, args, error);
      if (error !== null && (typeof error === "object" || typeof error === "function")) {
        try {
          Object.defineProperty(error, "loopGuardDecision", {
            value: failed,
            enumerable: false,
            configurable: true,
            writable: true,
          });
        } catch {
          // Frozen or exotic error objects can't carry the decision — ignore.
        }
      }
      throw error;
    }

    const after = this.afterCall(toolName, args, result);
    return {
      executed: true,
      blocked: !after.allowed,
      phase: after.allowed ? null : "after",
      decision: after,
      before,
      after,
      result,
    };
  }

  /** Shared post-call bookkeeping for afterCall() and afterError(). */
  #record(toolName, args, computeResultSignature, kind) {
    this.#touchClock();

    if (this.totalCalls >= this.options.maxCalls) {
      return this.#decision({
        allowed: false,
        code: "BUDGET_EXHAUSTED",
        stagnant: false,
        reason: `Call budget exhausted (${this.options.maxCalls} calls used).`,
        suggestedAction: "stop",
        suggestionDetail: "End the run and surface a summary to the user rather than continuing — the budget exists to prevent runaway cost/time.",
        warnings: [],
      });
    }

    this.totalCalls += 1;
    this.callsByTool.set(toolName, (this.callsByTool.get(toolName) ?? 0) + 1);

    const signature = this.#boundedSignature(toolName, args);
    const resultSignature = computeResultSignature();

    if (signature === this.lastSignature) {
      this.consecutiveRepeatCount += 1;
    } else {
      this.consecutiveRepeatCount = 1;
    }
    this.lastSignature = signature;

    this.uniqueSignatures.add(signature);

    const stagnantCount =
      signature === this.lastResultCallSignature && resultSignature === this.lastResultSignature
        ? this.consecutiveResultCount + 1
        : 1;

    this.lastResultCallSignature = signature;
    this.lastResultSignature = resultSignature;
    this.consecutiveResultCount = stagnantCount;

    if (this.options.windowSize > 0) {
      this.recentSignatures.push(signature);
      if (this.recentSignatures.length > this.options.windowSize) {
        this.recentSignatures.shift();
      }
    }

    if (this.options.maxCycleLength > 0) {
      const entry = Object.freeze({
        callSignature: signature,
        resultSignature,
      });
      this.callHistory.push(entry);
      const historyLimit = this.options.maxCycleLength * this.options.cycleThreshold;
      if (this.callHistory.length > historyLimit) {
        this.callHistory.shift();
      }
    }

    if (stagnantCount >= this.options.stagnationThreshold) {
      const reason =
        kind === "error"
          ? `"${toolName}" has failed with the same error ${stagnantCount} times for the same arguments — retrying is not making progress.`
          : `"${toolName}" has returned the same result ${stagnantCount} times for the same arguments — the agent is not making progress and should change strategy.`;
      const suggestionDetail =
        kind === "error"
          ? `The last ${stagnantCount} calls to "${toolName}" with these arguments failed identically. Fix the inputs, use a different tool, or escalate to the user with the error text instead of retrying.`
          : `The last ${stagnantCount} calls to "${toolName}" with these arguments all returned the same result. Repeating it again won't help — try a different tool, different arguments, or escalate to the user with what's been tried so far.`;

      return this.#decision({
        allowed: false,
        code: "STAGNANT_RESULT",
        stagnant: true,
        reason,
        suggestedAction: "change_approach",
        suggestionDetail,
        warnings: [],
      });
    }

    if (this.options.maxCycleLength > 0) {
      const maxDetectableLength = Math.min(
        this.options.maxCycleLength,
        Math.floor(this.callHistory.length / this.options.cycleThreshold)
      );

      for (let len = 2; len <= maxDetectableLength; len++) {
        const cycleThreshold = this.options.cycleThreshold;
        const sequence = this.callHistory.slice(this.callHistory.length - len);

        const isLengthOnePattern = sequence.every(
          (entry) => sameCycleEntry(entry, sequence[0])
        );
        if (isLengthOnePattern) {
          continue;
        }

        let isCycle = true;
        for (let i = 1; i < cycleThreshold; i++) {
          const offset = this.callHistory.length - len * (i + 1);
          for (let j = 0; j < len; j++) {
            if (!sameCycleEntry(this.callHistory[offset + j], sequence[j])) {
              isCycle = false;
              break;
            }
          }
          if (!isCycle) break;
        }
        if (isCycle) {
          return this.#decision({
            allowed: false,
            code: "CYCLE_DETECTED",
            stagnant: false,
            reason: `A repeating sequence of tool calls (length ${len}) has been detected ${cycleThreshold} times in a row.`,
            suggestedAction: "change_approach",
            suggestionDetail: `The agent is alternating between the same set of tool calls without progressing. Review the recent steps and break the loop by taking a different action or escalating to the user.`,
            warnings: [],
          });
        }
      }
    }

    const warnings = this.#budgetWarnings(toolName, []);
    // Same headroom rule as APPROACHING_REPEAT_LIMIT above.
    if (this.options.warn && stagnantCount >= 2 && stagnantCount >= this.options.stagnationThreshold - 1) {
      warnings.push({
        code: "APPROACHING_STAGNATION",
        message:
          kind === "error"
            ? `"${toolName}" has now failed identically ${stagnantCount} time(s) for these arguments. One more identical failure will be blocked.`
            : `"${toolName}" has now returned the same result ${stagnantCount} time(s) for these arguments. One more identical result will be blocked.`,
      });
    }

    return this.#decision({
      allowed: true,
      code: "OK",
      stagnant: false,
      reason: null,
      suggestedAction: null,
      suggestionDetail: null,
      warnings,
    });
  }

  /** Returns a summary, useful for logging at the end of a run. */
  summary() {
    const callsByTool = {};
    for (const [tool, count] of this.callsByTool) {
      callsByTool[tool] = count;
    }
    return {
      totalCalls: this.totalCalls,
      uniqueCallSignatures: this.uniqueSignatures.size,
      budgetRemaining: Math.max(0, this.options.maxCalls - this.totalCalls),
      blockedCalls: this.blockedCalls,
      elapsedMs: this.#elapsedMs(),
      callsByTool,
      decisionsByCode: { ...this.decisionsByCode },
    };
  }

  /**
   * Renders the current run state as a short plain-text block suitable for
   * feeding back into a model's context (e.g. as a system note).
   */
  report() {
    const summary = this.summary();
    const tools = Object.entries(summary.callsByTool)
      .sort((left, right) => right[1] - left[1])
      .map(([tool, count]) => `${tool}×${count}`)
      .join(", ");

    const lines = [
      `Tool calls: ${summary.totalCalls}/${this.options.maxCalls} (${summary.budgetRemaining} remaining).`,
      `Distinct calls: ${summary.uniqueCallSignatures}. Blocked: ${summary.blockedCalls}.`,
    ];
    if (tools) lines.push(`By tool: ${tools}.`);
    if (this.options.maxDurationMs > 0) {
      lines.push(`Elapsed: ${summary.elapsedMs}ms of ${this.options.maxDurationMs}ms allowed.`);
    }
    return lines.join("\n");
  }

  reset() {
    this.#assertNotDeliveringDecision("reset");
    this.#initState();
  }

  /**
   * Serializes run state so a guard can be rehydrated in another process or
   * after a restart. Options (including hook functions) are NOT serialized —
   * pass them again to LoopGuard.fromJSON().
   */
  toJSON() {
    return {
      version: STATE_VERSION,
      totalCalls: this.totalCalls,
      uniqueSignatures: [...this.uniqueSignatures],
      consecutiveRepeatCount: this.consecutiveRepeatCount,
      lastSignature: this.lastSignature,
      lastResultCallSignature: this.lastResultCallSignature,
      lastResultSignature: this.lastResultSignature,
      consecutiveResultCount: this.consecutiveResultCount,
      callHistory: this.callHistory.map((entry) => [entry.callSignature, entry.resultSignature]),
      recentSignatures: [...this.recentSignatures],
      callsByTool: Object.fromEntries(this.callsByTool),
      decisionsByCode: { ...this.decisionsByCode },
      blockedCalls: this.blockedCalls,
      elapsedMs: this.#elapsedMs(),
    };
  }

  /** Rebuilds a guard from toJSON() state. Options must be supplied again. */
  static fromJSON(state, options = {}) {
    if (state === null || typeof state !== "object" || Array.isArray(state)) {
      throw new TypeError("LoopGuard.fromJSON() requires a state object.");
    }
    if (state.version !== STATE_VERSION) {
      throw new TypeError(
        `Unsupported LoopGuard state version: ${String(state.version)} (expected ${STATE_VERSION}).`
      );
    }

    const guard = new LoopGuard(options);
    guard.totalCalls = state.totalCalls ?? 0;
    guard.uniqueSignatures = new Set(state.uniqueSignatures ?? []);
    guard.consecutiveRepeatCount = state.consecutiveRepeatCount ?? 0;
    guard.lastSignature = state.lastSignature ?? null;
    guard.lastResultCallSignature = state.lastResultCallSignature ?? null;
    guard.lastResultSignature = state.lastResultSignature ?? null;
    guard.consecutiveResultCount = state.consecutiveResultCount ?? 0;
    guard.callHistory = (state.callHistory ?? []).map((entry) =>
      Object.freeze({ callSignature: entry[0], resultSignature: entry[1] })
    );
    guard.recentSignatures = [...(state.recentSignatures ?? [])];
    guard.callsByTool = new Map(Object.entries(state.callsByTool ?? {}));
    guard.decisionsByCode = { ...(state.decisionsByCode ?? {}) };
    guard.blockedCalls = state.blockedCalls ?? 0;
    guard.startedAt = guard.clock() - (state.elapsedMs ?? 0);
    return guard;
  }

  /**
   * Builds a call signature and, if it exceeds maxSignatureLength,
   * collapses it to a short hash so pathologically large arguments
   * don't bloat retained history or comparisons.
   */
  #boundedSignature(toolName, args) {
    let signature;
    if (typeof this.options.signature === "function") {
      signature = this.options.signature(toolName, args);
      if (typeof signature !== "string") {
        throw new TypeError("Custom signature function must return a string.");
      }
    } else {
      signature = callSignature(toolName, args);
    }

    if (signature.length <= this.options.maxSignatureLength) {
      return signature;
    }
    const toolPreview = toolName.slice(0, 40);
    return `$tool:${JSON.stringify(toolPreview)}:$hash:${hashSignature(signature)}:len${signature.length}`;
  }

  /**
   * Computes a signature for a tool result, handling built-in serialization 
   * failures (unsupported values like functions) safely by returning an identity string.
   * Note: if a custom resultSignature function is provided, errors from it will propagate.
   */
  #safeResultSignature(result) {
    let signature;
    if (typeof this.options.resultSignature === "function") {
      signature = this.options.resultSignature(result);
      if (typeof signature !== "string") {
        throw new TypeError("Custom resultSignature function must return a string.");
      }
    } else {
      try {
        signature = callSignature("result", result);
      } catch {
        return this.#unsupportedResultSignature(result);
      }
    }

    return this.#boundSignatureLength(signature);
  }

  /**
   * Computes a signature for a thrown error. The default derives it from the
   * error's name, code, and message so two identical failures collapse to the
   * same signature without serializing arbitrary error properties.
   */
  #boundedErrorSignature(error) {
    let signature;
    if (typeof this.options.errorSignature === "function") {
      signature = this.options.errorSignature(error);
      if (typeof signature !== "string") {
        throw new TypeError("Custom errorSignature function must return a string.");
      }
    } else {
      signature = defaultErrorSignature(error);
    }

    return this.#boundSignatureLength(signature);
  }

  #boundSignatureLength(signature) {
    if (signature.length <= this.options.maxSignatureLength) {
      return signature;
    }
    return `$hash:${hashSignature(signature)}:len${signature.length}`;
  }

  #unsupportedResultSignature(result) {
    if ((typeof result === "object" && result !== null) || typeof result === "function") {
      let id = this.unsupportedObjectIds.get(result);
      if (id === undefined) {
        id = this.nextUnsupportedId++;
        this.unsupportedObjectIds.set(result, id);
      }
      return `$unsupported:${typeof result}:id${id}`;
    }

    // typeof result === "symbol" — the only remaining case reachable here.
    // stableStringify() only ever throws for object/function/symbol values,
    // so every other primitive returns from the branch above without erroring.
    let id = this.unsupportedSymbolIds.get(result);
    if (id === undefined) {
      id = this.nextUnsupportedId++;
      this.unsupportedSymbolIds.set(result, id);
    }
    return `$unsupported:symbol:id${id}`;
  }
}

function validateToolBudgets(value) {
  if (value === null) return;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      "LoopGuard option maxCallsPerTool must be an object mapping tool names to positive integers, or null."
    );
  }
  for (const key of Object.keys(value)) {
    const budget = value[key];
    if (!Number.isInteger(budget) || budget < 1) {
      throw new TypeError(
        `LoopGuard option maxCallsPerTool["${key}"] must be a positive integer.`
      );
    }
  }
}

function validateOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("LoopGuard options must be an object.");
  }

  const ownOption = (key) =>
    Object.hasOwn(options, key) ? options[key] : undefined;

  for (const key of Object.keys(options)) {
    if (!Object.hasOwn(OPTION_SPECS, key)) {
      throw new TypeError(`Unknown LoopGuard option: ${key}.`);
    }

    const spec = OPTION_SPECS[key];
    const value = options[key];

    if (spec.kind === "function") {
      if (value !== null && typeof value !== "function") {
        throw new TypeError(`LoopGuard option ${key} must be a function or null.`);
      }
      continue;
    }

    if (spec.kind === "boolean") {
      if (typeof value !== "boolean") {
        throw new TypeError(`LoopGuard option ${key} must be a boolean.`);
      }
      continue;
    }

    if (spec.kind === "toolBudgets") {
      validateToolBudgets(value);
      continue;
    }

    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(`LoopGuard option ${key} must be a non-negative integer.`);
    }
    if (value === 0 && !spec.allowZero) {
      throw new TypeError(`LoopGuard option ${key} must be a positive integer.`);
    }
    if (value !== 0 && value < spec.min) {
      throw new TypeError(
        spec.allowZero
          ? `LoopGuard option ${key} must be 0 or at least ${spec.min}.`
          : `LoopGuard option ${key} must be at least ${spec.min}.`
      );
    }
    if (spec.max !== undefined && value > spec.max) {
      throw new TypeError(
        key === "maxCycleLength"
          ? `LoopGuard option maxCycleLength must not exceed ${MAX_CYCLE_LENGTH} (cycle detection cost scales roughly with maxCycleLength² × cycleThreshold per call — see the README's Configuration section).`
          : `LoopGuard option ${key} must not exceed ${spec.max}.`
      );
    }
  }

  // Cross-option check against effective values, so `{ windowSize: 2 }` with the
  // default maxRepeatsInWindow of 3 fails loudly instead of never firing.
  const windowSize = ownOption("windowSize") ?? DEFAULT_OPTIONS.windowSize;
  const maxRepeatsInWindow =
    ownOption("maxRepeatsInWindow") ?? DEFAULT_OPTIONS.maxRepeatsInWindow;
  if (windowSize > 0 && maxRepeatsInWindow > windowSize) {
    throw new TypeError(
      "LoopGuard option maxRepeatsInWindow must not exceed windowSize — it could never be reached."
    );
  }
}
