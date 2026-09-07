/**
 * A runnable sketch of an agent loop wired up with agent-loop-guard.
 *
 *   node examples/agent-loop.mjs
 *
 * The fake "model" below deliberately gets stuck: it retries the same search,
 * interleaves an unrelated call, retries again, and eventually hits a tool that
 * always fails. The guard catches each pattern and hands back a next step.
 */

import { LoopGuard } from "../src/index.js";

const guard = new LoopGuard({
  maxCalls: 20,
  maxCallsPerTool: { search: 4 },
  maxDurationMs: 30_000,
  repeatThreshold: 3,
  stagnationThreshold: 2,
  windowSize: 6,
  maxRepeatsInWindow: 3,
  budgetWarnAt: 3,
  onDecision: (decision) => {
    if (!decision.allowed) console.log(`  [guard] blocked: ${decision.code}`);
  },
});

// A stand-in for a real tool dispatcher.
const tools = {
  search: async ({ query }) => ({ query, hits: ["always the same hit"] }),
  read_file: async ({ path }) => `contents of ${path}`,
  deploy: async () => {
    throw Object.assign(new Error("permission denied"), { code: "EACCES" });
  },
};

// A stand-in for a model that keeps proposing the same steps.
const proposedSteps = [
  { tool: "search", args: { query: "customer record" } },
  { tool: "search", args: { query: "customer record" } },
  { tool: "read_file", args: { path: "notes.md" } },
  { tool: "search", args: { query: "customer record" } },
  { tool: "deploy", args: { env: "prod" } },
  { tool: "deploy", args: { env: "prod" } },
  { tool: "read_file", args: { path: "notes.md" } },
];

const systemNotes = [];

for (const step of proposedSteps) {
  console.log(`\n→ ${step.tool}(${JSON.stringify(step.args)})`);

  let outcome;
  try {
    outcome = await guard.run(step.tool, step.args, () =>
      tools[step.tool](step.args)
    );
  } catch (error) {
    // The tool threw. The guard already recorded the failure.
    const decision = error.loopGuardDecision;
    console.log(`  tool failed: ${error.message}`);
    if (decision && !decision.allowed) {
      systemNotes.push(decision.suggestionDetail);
      console.log(`  ↳ ${decision.suggestionDetail}`);
      break;
    }
    continue;
  }

  for (const warning of outcome.decision.warnings) {
    console.log(`  ⚠ ${warning.code}: ${warning.message}`);
  }

  if (!outcome.executed) {
    console.log(`  ↳ never ran. ${outcome.decision.suggestionDetail}`);
    systemNotes.push(outcome.decision.suggestionDetail);
    continue; // a different tool may still be allowed
  }

  console.log(`  result: ${JSON.stringify(outcome.result)}`);

  if (outcome.blocked) {
    console.log(`  ↳ ${outcome.decision.suggestionDetail}`);
    systemNotes.push(outcome.decision.suggestionDetail);
  }
}

console.log(`\n--- run report ---\n${guard.report()}`);
console.log(`\nSystem notes fed back to the model: ${systemNotes.length}`);

// State can outlive the process:
const snapshot = JSON.stringify(guard);
const resumed = LoopGuard.fromJSON(JSON.parse(snapshot), { maxCalls: 20 });
console.log(`Resumed guard sees ${resumed.summary().totalCalls} prior calls.`);
