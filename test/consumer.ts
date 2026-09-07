import { LoopGuard, GuardDecision, LoopGuardOptions } from "../src/index.js";

// This file is used in CI to verify that the TypeScript definitions are correct.
// It is not meant to be executed.

const options: LoopGuardOptions = {
  maxCalls: 10,
  repeatThreshold: 2,
  stagnationThreshold: 2,
  maxCycleLength: 4,
  cycleThreshold: 2,
  signature: (toolName, args) => `${toolName}-${JSON.stringify(args)}`,
  resultSignature: (result) => JSON.stringify(result),
  onDecision: (decision: GuardDecision) => {
    if (!decision.allowed) {
      console.log(`Blocked: ${decision.code} - ${decision.reason}`);
    }
  }
};

const guard = new LoopGuard(options);

const decisionBefore = guard.beforeCall("search", { query: "test" });
if (!decisionBefore.allowed) {
  const code = decisionBefore.code; // TypeScript should know this is Exclude<DecisionCode, "OK" | "STAGNANT_RESULT">
}

const decisionAfter = guard.afterCall("search", { query: "test" }, { results: [] });
if (decisionAfter.allowed) {
  const isStagnant = decisionAfter.stagnant; // boolean
}

const summary = guard.summary();
console.log(summary.totalCalls, summary.budgetRemaining, summary.uniqueCallSignatures);

// --- 0.2.0 surface ---------------------------------------------------------

import type {
  RunOutcome,
  LoopGuardState,
  GuardWarning,
  LoopGuardSummary,
} from "../src/index.js";

const guarded = new LoopGuard({
  maxCallsPerTool: { search: 10 },
  maxDurationMs: 30_000,
  windowSize: 20,
  maxRepeatsInWindow: 4,
  warn: true,
  budgetWarnAt: 3,
  errorSignature: (error) => (error instanceof Error ? error.name : "unknown"),
  now: () => Date.now(),
});

const warnings: GuardWarning[] = guarded.beforeCall("search", { q: "cats" }).warnings;
for (const warning of warnings) {
  console.log(warning.code, warning.message);
}

async function useRun(): Promise<void> {
  const outcome: RunOutcome<{ hits: number }> = await guarded.run(
    "search",
    { q: "cats" },
    async () => ({ hits: 3 })
  );

  if (outcome.executed) {
    const hits: number = outcome.result.hits;
    console.log(hits, outcome.after.code);
  } else {
    console.log(outcome.decision.suggestionDetail);
  }
}
void useRun();

guarded.afterError("search", { q: "cats" }, new Error("timeout"));

const state: LoopGuardState = guarded.toJSON();
const restored = LoopGuard.fromJSON(state, { maxCalls: 10 });
const restoredSummary: LoopGuardSummary = restored.summary();
console.log(restoredSummary.callsByTool, restoredSummary.blockedCalls, restored.report());
