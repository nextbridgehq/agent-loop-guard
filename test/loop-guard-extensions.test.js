import { test } from "node:test";
import assert from "node:assert/strict";
import { LoopGuard } from "../src/loop-guard.js";

/* ------------------------------------------------------------------ */
/* Per-tool budgets                                                     */
/* ------------------------------------------------------------------ */

test("per-tool budget blocks a single tool without ending the run", () => {
  const guard = new LoopGuard({
    maxCalls: 50,
    repeatThreshold: 10,
    stagnationThreshold: 10,
    maxCallsPerTool: { search: 2 },
  });

  guard.afterCall("search", { q: "a" }, "1");
  guard.afterCall("search", { q: "b" }, "2");

  const blocked = guard.beforeCall("search", { q: "c" });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, "TOOL_BUDGET_EXHAUSTED");
  assert.equal(blocked.suggestedAction, "change_approach");
  assert.match(blocked.reason, /search/);

  // A different tool is unaffected — the run continues.
  assert.equal(guard.beforeCall("read_file", { path: "a" }).allowed, true);
});

test("tools without a configured budget are unlimited", () => {
  const guard = new LoopGuard({
    maxCalls: 50,
    repeatThreshold: 10,
    stagnationThreshold: 10,
    maxCallsPerTool: { search: 1 },
  });

  for (let index = 0; index < 10; index += 1) {
    guard.afterCall("read_file", { index }, `content-${index}`);
  }
  assert.equal(guard.beforeCall("read_file", { index: 99 }).allowed, true);
});

test("maxCallsPerTool rejects invalid shapes", () => {
  assert.throws(() => new LoopGuard({ maxCallsPerTool: 5 }), /maxCallsPerTool must be an object/i);
  assert.throws(() => new LoopGuard({ maxCallsPerTool: [] }), /maxCallsPerTool must be an object/i);
  assert.throws(() => new LoopGuard({ maxCallsPerTool: { search: 0 } }), /positive integer/i);
  assert.throws(() => new LoopGuard({ maxCallsPerTool: { search: 1.5 } }), /positive integer/i);
  assert.doesNotThrow(() => new LoopGuard({ maxCallsPerTool: null }));
});

/* ------------------------------------------------------------------ */
/* Windowed (non-consecutive) repeat detection                          */
/* ------------------------------------------------------------------ */

test("detects the same call repeating inside a window even when interleaved", () => {
  const guard = new LoopGuard({
    maxCalls: 50,
    repeatThreshold: 10,
    stagnationThreshold: 10,
    windowSize: 6,
    maxRepeatsInWindow: 3,
  });

  guard.afterCall("search", { q: "cats" }, "r1");
  guard.afterCall("read_file", { path: "a" }, "a1");
  guard.afterCall("search", { q: "cats" }, "r2");
  guard.afterCall("read_file", { path: "b" }, "b1");

  const blocked = guard.beforeCall("search", { q: "cats" });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, "REPEATED_CALL_IN_WINDOW");
  assert.match(blocked.suggestionDetail, /change the arguments/i);
});

test("window forgets calls that scroll out of it", () => {
  const guard = new LoopGuard({
    maxCalls: 50,
    repeatThreshold: 10,
    stagnationThreshold: 10,
    windowSize: 2,
    maxRepeatsInWindow: 2,
  });

  guard.afterCall("search", { q: "cats" }, "r1");
  guard.afterCall("read_file", { path: "a" }, "a1");
  guard.afterCall("read_file", { path: "b" }, "b1");

  // The earlier search has scrolled out of the 2-call window.
  assert.equal(guard.beforeCall("search", { q: "cats" }).allowed, true);
});

test("windowed detection is disabled by default", () => {
  const guard = new LoopGuard({ repeatThreshold: 10, stagnationThreshold: 10 });
  for (let index = 0; index < 10; index += 1) {
    guard.afterCall("search", { q: "cats" }, `r${index}`);
    guard.afterCall("read_file", { index }, `c${index}`);
  }
  assert.equal(guard.beforeCall("search", { q: "cats" }).allowed, true);
});

test("rejects window options that could never fire", () => {
  assert.throws(() => new LoopGuard({ windowSize: 1 }), /0 or at least 2/i);
  assert.throws(() => new LoopGuard({ windowSize: 20_000 }), /must not exceed 10000/i);
  assert.throws(
    () => new LoopGuard({ windowSize: 3, maxRepeatsInWindow: 4 }),
    /must not exceed windowSize/i
  );
  // Checked against effective values, so the default maxRepeatsInWindow (3)
  // makes a windowSize of 2 a dead config rather than a silent no-op.
  assert.throws(() => new LoopGuard({ windowSize: 2 }), /must not exceed windowSize/i);
});

/* ------------------------------------------------------------------ */
/* Wall-clock budget                                                    */
/* ------------------------------------------------------------------ */

test("blocks once the wall-clock budget is spent", () => {
  let now = 1_000;
  const guard = new LoopGuard({ maxDurationMs: 5_000, now: () => now });

  assert.equal(guard.beforeCall("search", { q: "a" }).allowed, true);
  guard.afterCall("search", { q: "a" }, "r1");

  now += 4_999;
  assert.equal(guard.beforeCall("search", { q: "b" }).allowed, true);

  now += 1;
  const blocked = guard.beforeCall("search", { q: "c" });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, "TIME_BUDGET_EXHAUSTED");
  assert.equal(blocked.suggestedAction, "stop");
  assert.match(blocked.reason, /5000ms/);
});

test("the clock starts at the first call, not at construction", () => {
  let now = 0;
  const guard = new LoopGuard({ maxDurationMs: 1_000, now: () => now });

  now = 60_000; // guard sat idle for a minute before the run started
  assert.equal(guard.beforeCall("search", {}).allowed, true);
  assert.equal(guard.summary().elapsedMs, 0);
});

test("reset() restarts the wall-clock window", () => {
  let now = 0;
  const guard = new LoopGuard({ maxDurationMs: 100, now: () => now });
  guard.beforeCall("search", {});
  now = 500;
  assert.equal(guard.beforeCall("search", {}).code, "TIME_BUDGET_EXHAUSTED");

  guard.reset();
  assert.equal(guard.beforeCall("search", {}).allowed, true);
});

/* ------------------------------------------------------------------ */
/* Early warnings                                                       */
/* ------------------------------------------------------------------ */

test("warns before the call budget runs out", () => {
  const guard = new LoopGuard({
    maxCalls: 4,
    budgetWarnAt: 2,
    repeatThreshold: 10,
    stagnationThreshold: 10,
  });

  assert.deepEqual(guard.beforeCall("search", { q: 1 }).warnings, []);
  guard.afterCall("search", { q: 1 }, "r1");
  guard.afterCall("search", { q: 2 }, "r2");

  const warned = guard.beforeCall("search", { q: 3 });
  assert.equal(warned.allowed, true);
  assert.equal(warned.warnings.length, 1);
  assert.equal(warned.warnings[0].code, "APPROACHING_BUDGET");
  assert.match(warned.warnings[0].message, /2 of 4/);
});

test("warns one call before the repeat limit blocks", () => {
  const guard = new LoopGuard({ repeatThreshold: 3, stagnationThreshold: 10 });
  const args = { file: "index.js" };

  guard.afterCall("read_file", args, "v1");
  const warned = guard.beforeCall("read_file", args);
  assert.equal(warned.allowed, true);
  assert.equal(warned.warnings[0].code, "APPROACHING_REPEAT_LIMIT");

  guard.afterCall("read_file", args, "v2");
  assert.equal(guard.beforeCall("read_file", args).code, "REPEATED_CALL");
});

test("warns one result before stagnation blocks", () => {
  const guard = new LoopGuard({ stagnationThreshold: 3, repeatThreshold: 10 });
  const args = { query: "weather" };

  guard.afterCall("search", args, { temp: 72 });
  const warned = guard.afterCall("search", args, { temp: 72 });
  assert.equal(warned.allowed, true);
  assert.equal(warned.warnings[0].code, "APPROACHING_STAGNATION");

  assert.equal(guard.afterCall("search", args, { temp: 72 }).code, "STAGNANT_RESULT");
});

test("no 'approaching' warning fires when a threshold has no headroom", () => {
  const guard = new LoopGuard({ repeatThreshold: 2, stagnationThreshold: 2, budgetWarnAt: 0 });
  assert.deepEqual(guard.beforeCall("search", { q: 1 }).warnings, []);
  assert.deepEqual(guard.afterCall("search", { q: 1 }, "r").warnings, []);
});

test("warn: false suppresses all warnings", () => {
  const guard = new LoopGuard({ maxCalls: 2, warn: false, repeatThreshold: 10, stagnationThreshold: 10 });
  guard.afterCall("search", { q: 1 }, "r1");
  assert.deepEqual(guard.beforeCall("search", { q: 2 }).warnings, []);
});

test("warn and budgetWarnAt are validated", () => {
  assert.throws(() => new LoopGuard({ warn: 1 }), /must be a boolean/i);
  assert.throws(() => new LoopGuard({ budgetWarnAt: -1 }), /non-negative integer/i);
  assert.doesNotThrow(() => new LoopGuard({ budgetWarnAt: 0 }));
});

test("onDecision receives frozen warnings", () => {
  const seen = [];
  const guard = new LoopGuard({
    maxCalls: 2,
    budgetWarnAt: 5,
    repeatThreshold: 10,
    stagnationThreshold: 10,
    onDecision: (decision) => seen.push(decision),
  });

  guard.beforeCall("search", { q: 1 });
  assert.equal(seen.length, 1);
  assert.ok(Object.isFrozen(seen[0]));
  assert.ok(Object.isFrozen(seen[0].warnings));
  assert.equal(seen[0].warnings[0].code, "APPROACHING_BUDGET");
});

/* ------------------------------------------------------------------ */
/* run()                                                                */
/* ------------------------------------------------------------------ */

test("run() executes the tool and returns both decisions", async () => {
  const guard = new LoopGuard();
  const outcome = await guard.run("search", { q: "cats" }, () => ({ hits: 3 }));

  assert.equal(outcome.executed, true);
  assert.equal(outcome.blocked, false);
  assert.equal(outcome.phase, null);
  assert.deepEqual(outcome.result, { hits: 3 });
  assert.equal(outcome.before.code, "OK");
  assert.equal(outcome.after.code, "OK");
  assert.equal(guard.summary().totalCalls, 1);
});

test("run() skips execution when beforeCall blocks", async () => {
  const guard = new LoopGuard({ maxCalls: 1 });
  await guard.run("search", { q: "a" }, () => "r1");

  let called = false;
  const outcome = await guard.run("search", { q: "b" }, () => {
    called = true;
    return "r2";
  });

  assert.equal(called, false);
  assert.equal(outcome.executed, false);
  assert.equal(outcome.blocked, true);
  assert.equal(outcome.phase, "before");
  assert.equal(outcome.decision.code, "BUDGET_EXHAUSTED");
  assert.equal(outcome.after, null);
});

test("run() reports an after-call block while still returning the result", async () => {
  const guard = new LoopGuard({ stagnationThreshold: 2, repeatThreshold: 10 });
  await guard.run("search", { q: "cats" }, () => "same");
  const outcome = await guard.run("search", { q: "cats" }, () => "same");

  assert.equal(outcome.executed, true);
  assert.equal(outcome.blocked, true);
  assert.equal(outcome.phase, "after");
  assert.equal(outcome.result, "same");
  assert.equal(outcome.decision.code, "STAGNANT_RESULT");
});

test("run() records failures and re-throws with the decision attached", async () => {
  const guard = new LoopGuard({ stagnationThreshold: 2, repeatThreshold: 10 });
  const fail = () => {
    throw new Error("ECONNRESET while fetching");
  };

  await assert.rejects(() => guard.run("fetch", { url: "x" }, fail), /ECONNRESET/);

  const second = await guard
    .run("fetch", { url: "x" }, fail)
    .then(() => null, (error) => error);

  assert.ok(second instanceof Error);
  assert.equal(second.loopGuardDecision.code, "STAGNANT_RESULT");
  assert.match(second.loopGuardDecision.reason, /failed with the same error/i);
  assert.equal(guard.summary().totalCalls, 2);
});

test("run() awaits async executors and rejects non-functions", async () => {
  const guard = new LoopGuard();
  const outcome = await guard.run("search", {}, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return "async-result";
  });
  assert.equal(outcome.result, "async-result");

  await assert.rejects(() => guard.run("search", {}, "not-a-function"), /executor function/i);
});

/* ------------------------------------------------------------------ */
/* afterError()                                                         */
/* ------------------------------------------------------------------ */

test("afterError() distinguishes different failures from identical ones", () => {
  const guard = new LoopGuard({ stagnationThreshold: 2, repeatThreshold: 10 });

  assert.equal(guard.afterError("fetch", { url: "x" }, new Error("timeout")).allowed, true);
  assert.equal(guard.afterError("fetch", { url: "x" }, new Error("not found")).allowed, true);

  guard.afterError("fetch", { url: "x" }, new Error("timeout"));
  const blocked = guard.afterError("fetch", { url: "x" }, new Error("timeout"));
  assert.equal(blocked.code, "STAGNANT_RESULT");
  assert.equal(blocked.stagnant, true);
  assert.match(blocked.suggestionDetail, /escalate to the user with the error text/i);
});

test("afterError() handles non-Error throws", () => {
  const guard = new LoopGuard({ stagnationThreshold: 2, repeatThreshold: 10 });
  guard.afterError("fetch", { url: "x" }, "plain string failure");
  const blocked = guard.afterError("fetch", { url: "x" }, "plain string failure");
  assert.equal(blocked.code, "STAGNANT_RESULT");
});

test("errorSignature hook overrides the default", () => {
  const guard = new LoopGuard({
    stagnationThreshold: 2,
    repeatThreshold: 10,
    errorSignature: (error) => `status:${error.status}`,
  });

  // Different messages, same status — treated as the same failure.
  guard.afterError("fetch", { url: "x" }, Object.assign(new Error("a"), { status: 500 }));
  const blocked = guard.afterError("fetch", { url: "x" }, Object.assign(new Error("b"), { status: 500 }));
  assert.equal(blocked.code, "STAGNANT_RESULT");

  assert.throws(
    () => new LoopGuard({ errorSignature: () => 42 }).afterError("t", {}, new Error("x")),
    /must return a string/i
  );
});

/* ------------------------------------------------------------------ */
/* State persistence                                                    */
/* ------------------------------------------------------------------ */

test("toJSON()/fromJSON() round-trips detection state across processes", () => {
  const options = { maxCalls: 10, repeatThreshold: 3, stagnationThreshold: 2, windowSize: 4 };
  const guard = new LoopGuard(options);
  const args = { file: "index.js" };

  guard.afterCall("read_file", args, "v1");
  guard.afterCall("read_file", args, "v2");

  const serialized = JSON.parse(JSON.stringify(guard));
  const restored = LoopGuard.fromJSON(serialized, options);

  assert.equal(restored.summary().totalCalls, 2);
  assert.equal(restored.summary().budgetRemaining, 8);
  assert.deepEqual(restored.summary().callsByTool, { read_file: 2 });

  // The consecutive-repeat streak survives the restart.
  const blocked = restored.beforeCall("read_file", args);
  assert.equal(blocked.code, "REPEATED_CALL");
});

test("fromJSON() rejects unusable state", () => {
  assert.throws(() => LoopGuard.fromJSON(null), /requires a state object/i);
  assert.throws(() => LoopGuard.fromJSON([]), /requires a state object/i);
  assert.throws(() => LoopGuard.fromJSON({ version: 99 }), /Unsupported LoopGuard state version/i);
});

test("fromJSON() preserves elapsed time against a fresh clock", () => {
  let now = 1_000;
  const guard = new LoopGuard({ maxDurationMs: 10_000, now: () => now });
  guard.beforeCall("search", {});
  now += 9_000;

  const state = guard.toJSON();
  assert.equal(state.elapsedMs, 9_000);

  now = 500_000; // different process, different clock offset
  const restored = LoopGuard.fromJSON(state, { maxDurationMs: 10_000, now: () => now });
  assert.equal(restored.summary().elapsedMs, 9_000);

  now += 1_001;
  assert.equal(restored.beforeCall("search", {}).code, "TIME_BUDGET_EXHAUSTED");
});

/* ------------------------------------------------------------------ */
/* Reporting                                                            */
/* ------------------------------------------------------------------ */

test("summary() exposes per-tool and per-code breakdowns", () => {
  const guard = new LoopGuard({ maxCalls: 10, repeatThreshold: 10, stagnationThreshold: 10 });
  guard.afterCall("search", { q: 1 }, "r1");
  guard.afterCall("search", { q: 2 }, "r2");
  guard.afterCall("read_file", { path: "a" }, "c1");

  const summary = guard.summary();
  assert.deepEqual(summary.callsByTool, { search: 2, read_file: 1 });
  assert.equal(summary.decisionsByCode.OK, 3);
  assert.equal(summary.blockedCalls, 0);
  assert.equal(typeof summary.elapsedMs, "number");
});

test("report() renders a model-readable status block", () => {
  const guard = new LoopGuard({ maxCalls: 10, repeatThreshold: 10, stagnationThreshold: 10 });
  guard.afterCall("search", { q: 1 }, "r1");
  guard.afterCall("search", { q: 2 }, "r2");

  const report = guard.report();
  assert.match(report, /Tool calls: 2\/10 \(8 remaining\)/);
  assert.match(report, /search×2/);
});

test("reset() clears the new counters too", () => {
  const guard = new LoopGuard({ maxCalls: 2, windowSize: 4, maxCallsPerTool: { search: 1 } });
  guard.afterCall("search", { q: 1 }, "r1");
  guard.beforeCall("search", { q: 2 }); // blocked by the per-tool budget

  guard.reset();
  const summary = guard.summary();
  assert.equal(summary.totalCalls, 0);
  assert.equal(summary.blockedCalls, 0);
  assert.deepEqual(summary.callsByTool, {});
  assert.deepEqual(summary.decisionsByCode, {});
  assert.equal(guard.beforeCall("search", { q: 3 }).allowed, true);
});
