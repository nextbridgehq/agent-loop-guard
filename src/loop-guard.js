import { callSignature, hashSignature } from "./signature.js";

const DEFAULT_OPTIONS = {
  maxCalls: 50,             // hard ceiling on total tool calls in a session
  repeatThreshold: 3,       // consecutive identical calls (same tool+args) before flagging
  stagnationThreshold: 2,   // identical (tool+args+result) pairs before flagging "no progress"
  maxSignatureLength: 200_000, // signatures longer than this are hashed down before storage
  maxCycleLength: 0,        // max sequence length to track for cycle detection (0 = disabled, max 1000 — see MAX_CYCLE_LENGTH)
  cycleThreshold: 2,        // how many times a sequence must repeat to be flagged
  signature: null,          // optional custom call signature function
  resultSignature: null,    // optional custom result signature function
  onDecision: null,         // optional observability hook: (decision) => void
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

/**
 * LoopGuard tracks an agent's tool-calling history within a single run
 * and flags patterns that indicate the agent is stuck: calling the same
 * tool with the same args repeatedly, or getting the same result back
 * without making progress.
 *
 * It does not call tools itself — it's a pure decision layer you check
 * before and after each tool call.
 */
export class LoopGuard {
  #deliveringDecision = false;

  constructor(options = {}) {
    validateOptions(options);
    this.options = { ...DEFAULT_OPTIONS, ...options };
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
  }

  #assertNotDeliveringDecision(methodName) {
    if (this.#deliveringDecision) {
      throw new Error(
        `LoopGuard ${methodName}() cannot be called from the same instance while onDecision is running.`
      );
    }
  }

  #decision(result) {
    if (typeof this.options.onDecision === "function") {
      this.#deliveringDecision = true;
      try {
        this.options.onDecision(Object.freeze({ ...result }));
      } catch (err) {
        // Ignore observability errors to prevent crashing the agent loop
      } finally {
        this.#deliveringDecision = false;
      }
    }
    return result;
  }

  /**
   * Call this BEFORE executing a tool call. Returns whether the call
   * should be allowed to proceed.
   */
  beforeCall(toolName, args) {
    this.#assertNotDeliveringDecision("beforeCall");
    validateToolName(toolName);

    if (this.totalCalls >= this.options.maxCalls) {
      return this.#decision({
        allowed: false,
        code: "BUDGET_EXHAUSTED",
        reason: `Call budget exhausted (${this.totalCalls}/${this.options.maxCalls} calls used).`,
        suggestedAction: "stop",
        suggestionDetail: "End the run and surface a summary to the user rather than continuing — the budget exists to prevent runaway cost/time, not to be silently raised.",
      });
    }

    const signature = this.#boundedSignature(toolName, args);

    if (signature === this.lastSignature) {
      const projectedRepeats = this.consecutiveRepeatCount + 1;
      if (projectedRepeats >= this.options.repeatThreshold) {
        return this.#decision({
          allowed: false,
          code: "REPEATED_CALL",
          reason: `"${toolName}" has been called with identical arguments ${projectedRepeats} times in a row. The agent appears stuck in a loop.`,
          suggestedAction: "change_approach",
          suggestionDetail: `Do not retry "${toolName}" with the same arguments. Either try different arguments, use a different tool to accomplish the same goal, or ask the user for clarification if the task is ambiguous.`,
        });
      }
    }

    return this.#decision({ allowed: true, code: "OK", reason: null, suggestedAction: null, suggestionDetail: null });
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

    if (this.totalCalls >= this.options.maxCalls) {
      return this.#decision({
        allowed: false,
        code: "BUDGET_EXHAUSTED",
        stagnant: false,
        reason: `Call budget exhausted (${this.options.maxCalls} calls used).`,
        suggestedAction: "stop",
        suggestionDetail: "End the run and surface a summary to the user rather than continuing — the budget exists to prevent runaway cost/time.",
      });
    }

    this.totalCalls += 1;

    const signature = this.#boundedSignature(toolName, args);
    const resultSignature = this.#safeResultSignature(result);

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
      return this.#decision({
        allowed: false,
        code: "STAGNANT_RESULT",
        stagnant: true,
        reason: `"${toolName}" has returned the same result ${stagnantCount} times for the same arguments — the agent is not making progress and should change strategy.`,
        suggestedAction: "change_approach",
        suggestionDetail: `The last ${stagnantCount} calls to "${toolName}" with these arguments all returned the same result. Repeating it again won't help — try a different tool, different arguments, or escalate to the user with what's been tried so far.`,
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
          });
        }
      }
    }

    return this.#decision({ allowed: true, code: "OK", stagnant: false, reason: null, suggestedAction: null, suggestionDetail: null });
  }

  /** Returns a simple summary, useful for logging at the end of a run. */
  summary() {
    return {
      totalCalls: this.totalCalls,
      uniqueCallSignatures: this.uniqueSignatures.size,
      budgetRemaining: Math.max(0, this.options.maxCalls - this.totalCalls),
    };
  }

  reset() {
    this.#assertNotDeliveringDecision("reset");
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

function validateOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("LoopGuard options must be an object.");
  }

  const ownOption = (key) =>
    Object.hasOwn(options, key) ? options[key] : undefined;

  for (const key of Object.keys(options)) {
    if (!Object.hasOwn(DEFAULT_OPTIONS, key)) {
      throw new TypeError(`Unknown LoopGuard option: ${key}.`);
    }
    if (key === "signature" || key === "resultSignature" || key === "onDecision") {
      if (options[key] !== null && typeof options[key] !== "function") {
        throw new TypeError(`LoopGuard option ${key} must be a function or null.`);
      }
      continue;
    }
    if (!Number.isInteger(options[key]) || options[key] < 0) {
      throw new TypeError(`LoopGuard option ${key} must be a non-negative integer.`);
    }
    if (options[key] === 0 && key !== "maxCycleLength") {
       throw new TypeError(`LoopGuard option ${key} must be a positive integer.`);
    }
  }

  const repeatThreshold = ownOption("repeatThreshold");
  const stagnationThreshold = ownOption("stagnationThreshold");
  const cycleThreshold = ownOption("cycleThreshold");
  const maxCycleLength = ownOption("maxCycleLength");

  if (repeatThreshold !== undefined && repeatThreshold < MIN_REPEAT_THRESHOLD) {
    throw new TypeError(`LoopGuard option repeatThreshold must be at least ${MIN_REPEAT_THRESHOLD}.`);
  }

  if (stagnationThreshold !== undefined && stagnationThreshold < MIN_STAGNATION_THRESHOLD) {
    throw new TypeError(`LoopGuard option stagnationThreshold must be at least ${MIN_STAGNATION_THRESHOLD}.`);
  }

  if (cycleThreshold !== undefined && cycleThreshold < MIN_CYCLE_THRESHOLD) {
    throw new TypeError(`LoopGuard option cycleThreshold must be at least ${MIN_CYCLE_THRESHOLD}.`);
  }

  if (maxCycleLength !== undefined && maxCycleLength !== 0 && maxCycleLength < 2) {
    throw new TypeError(`LoopGuard option maxCycleLength must be 0 or at least 2.`);
  }

  if (maxCycleLength !== undefined && maxCycleLength > MAX_CYCLE_LENGTH) {
    throw new TypeError(
      `LoopGuard option maxCycleLength must not exceed ${MAX_CYCLE_LENGTH} (cycle detection cost scales roughly with maxCycleLength² × cycleThreshold per call — see the README's Configuration section).`
    );
  }
}
