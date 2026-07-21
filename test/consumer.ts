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
