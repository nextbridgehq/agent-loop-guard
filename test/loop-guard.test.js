import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { LoopGuard } from "../src/loop-guard.js";
import { callSignature, hashSignature } from "../src/signature.js";

test("allows calls under the budget", () => {
  const guard = new LoopGuard({ maxCalls: 5 });
  const check = guard.beforeCall("search", { query: "cats" });
  assert.equal(check.allowed, true);
  assert.equal(check.code, "OK");
});

test("blocks calls once the budget is exhausted", () => {
  const guard = new LoopGuard({ maxCalls: 2 });
  guard.afterCall("search", { q: "a" }, { ok: true });
  guard.afterCall("search", { q: "b" }, { ok: true });
  const check = guard.beforeCall("search", { q: "c" });
  assert.equal(check.allowed, false);
  assert.equal(check.code, "BUDGET_EXHAUSTED");
  assert.match(check.reason, /budget exhausted/i);
});

test("flags repeated identical calls before hitting the threshold", () => {
  const guard = new LoopGuard({ maxCalls: 50, repeatThreshold: 3 });
  const args = { file: "index.js" };

  guard.afterCall("read_file", args, "content-v1");
  guard.afterCall("read_file", args, "content-v1");
  // Third identical call in a row should now be blocked pre-call.
  const check = guard.beforeCall("read_file", args);
  assert.equal(check.allowed, false);
  assert.equal(check.code, "REPEATED_CALL");
  assert.match(check.reason, /stuck in a loop/i);
  assert.equal(check.suggestedAction, "change_approach");
});

test("provides a 'stop' suggestion when budget is exhausted", () => {
  const guard = new LoopGuard({ maxCalls: 1 });
  guard.afterCall("search", { q: "a" }, { ok: true });
  const check = guard.beforeCall("search", { q: "b" });
  assert.equal(check.suggestedAction, "stop");
});

test("stagnation result includes a suggestionDetail with concrete next steps", () => {
  const guard = new LoopGuard({ maxCalls: 50, stagnationThreshold: 2 });
  const args = { query: "weather" };
  guard.afterCall("search", args, { temp: 72 });
  const second = guard.afterCall("search", args, { temp: 72 });
  assert.equal(second.allowed, false);
  assert.equal(second.code, "STAGNANT_RESULT");
  assert.equal(second.suggestedAction, "change_approach");
  assert.match(second.suggestionDetail, /try a different tool/i);
});

test("does not flag different args as repeats", () => {
  const guard = new LoopGuard({ maxCalls: 50, repeatThreshold: 2 });
  guard.afterCall("read_file", { file: "a.js" }, "content-a");
  const check = guard.beforeCall("read_file", { file: "b.js" });
  assert.equal(check.allowed, true);
});

test("detects stagnation: same call + same result repeating", () => {
  const guard = new LoopGuard({ maxCalls: 50, stagnationThreshold: 2 });
  const args = { query: "weather" };

  const first = guard.afterCall("search", args, { temp: 72 });
  assert.equal(first.stagnant, false);

  const second = guard.afterCall("search", args, { temp: 72 });
  assert.equal(second.stagnant, true);
  assert.match(second.reason, /not making progress/i);
});

test("does not flag stagnation when results differ each time", () => {
  const guard = new LoopGuard({ maxCalls: 50, stagnationThreshold: 2 });
  const args = { query: "weather" };

  guard.afterCall("search", args, { temp: 72 });
  const second = guard.afterCall("search", args, { temp: 73 });
  assert.equal(second.stagnant, false);
});

test("stagnation counts only consecutive identical results", () => {
  const identical = new LoopGuard({ stagnationThreshold: 2 });
  assert.equal(identical.afterCall("tool", {}, "A").stagnant, false);
  assert.equal(identical.afterCall("tool", {}, "A").stagnant, true);

  const interrupted = new LoopGuard({ stagnationThreshold: 2 });
  assert.equal(interrupted.afterCall("tool", {}, "A").stagnant, false);
  assert.equal(interrupted.afterCall("tool", {}, "B").stagnant, false);
  assert.equal(interrupted.afterCall("tool", {}, "A").stagnant, false);

  const newRun = new LoopGuard({ stagnationThreshold: 2 });
  assert.equal(newRun.afterCall("tool", {}, "A").stagnant, false);
  assert.equal(newRun.afterCall("tool", {}, "B").stagnant, false);
  assert.equal(newRun.afterCall("tool", {}, "B").stagnant, true);
});

test("summary reports call counts and unique signatures", () => {
  const guard = new LoopGuard({ maxCalls: 10 });
  guard.afterCall("search", { q: "a" }, "r1");
  guard.afterCall("search", { q: "b" }, "r2");
  guard.afterCall("search", { q: "a" }, "r1");

  const summary = guard.summary();
  assert.equal(summary.totalCalls, 3);
  assert.equal(summary.uniqueCallSignatures, 2);
  assert.equal(summary.budgetRemaining, 7);
});

test("reset clears history and counters", () => {
  const guard = new LoopGuard({ maxCalls: 10, maxCycleLength: 10 });
  guard.afterCall("search", { q: "a" }, "r1");
  guard.reset();
  const summary = guard.summary();
  assert.equal(summary.totalCalls, 0);
  assert.equal(summary.uniqueCallSignatures, 0);
  assert.equal(guard.callHistory.length, 0);
});

test("circular arguments are deterministic and do not crash", () => {
  const first = { name: "same" };
  first.self = first;
  const second = { name: "same" };
  second.self = second;
  assert.equal(callSignature("tool", first), callSignature("tool", second));
});

test("different circular results do not share a generic signature", () => {
  const guard = new LoopGuard({ stagnationThreshold: 2 });
  const first = { value: 1 };
  first.self = first;
  const second = { value: 2 };
  second.self = second;

  assert.equal(guard.afterCall("tool", {}, first).stagnant, false);
  assert.equal(guard.afterCall("tool", {}, second).stagnant, false);
});

test("BigInt values have deterministic signatures", () => {
  assert.equal(
    callSignature("tool", { value: 42n }),
    callSignature("tool", { value: 42n })
  );
  assert.notEqual(callSignature("tool", 42n), callSignature("tool", "42"));
});

test("distinguishes empty, sparse, and explicitly undefined arrays", () => {
  const signatures = [
    callSignature("tool", []),
    callSignature("tool", new Array(1)),
    callSignature("tool", [undefined]),
  ];
  assert.equal(new Set(signatures).size, 3);
});

test("hashSignature uses SHA-256 for determinism", () => {
  const hashEmpty = hashSignature("");
  assert.equal(hashEmpty.length, 64);
  assert.equal(hashEmpty, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("unsupported result fallbacks preserve identity", () => {
  const guard = new LoopGuard({ stagnationThreshold: 2 });
  const firstFunction = () => 1;
  const secondFunction = () => 1;
  assert.equal(guard.afterCall("tool", {}, firstFunction).stagnant, false);
  assert.equal(guard.afterCall("tool", {}, secondFunction).stagnant, false);
  assert.equal(guard.afterCall("tool", {}, secondFunction).stagnant, true);

  const maps = new LoopGuard({ stagnationThreshold: 2 });
  const firstMap = new Map();
  const secondMap = new Map();
  assert.equal(maps.afterCall("tool", {}, firstMap).stagnant, false);
  assert.equal(maps.afterCall("tool", {}, secondMap).stagnant, false);
  assert.equal(maps.afterCall("tool", {}, secondMap).stagnant, true);

  const symbols = new LoopGuard({ stagnationThreshold: 2 });
  const firstSymbol = Symbol("same");
  const secondSymbol = Symbol("same");
  assert.equal(symbols.afterCall("tool", {}, firstSymbol).stagnant, false);
  assert.equal(symbols.afterCall("tool", {}, secondSymbol).stagnant, false);
  assert.equal(symbols.afterCall("tool", {}, secondSymbol).stagnant, true);
});

test("undefined cannot collide with functions", () => {
  assert.doesNotThrow(() => callSignature("tool", { value: undefined }));
  assert.throws(
    () => callSignature("tool", { value() {} }),
    /unsupported function value/i
  );
});

test("handles Date, typed arrays, and class instances deterministically", () => {
  class Example {
    constructor(value) {
      this.value = value;
    }
  }

  assert.equal(
    callSignature("tool", {
      date: new Date("2024-01-01T00:00:00.000Z"),
      typed: new Uint16Array([1, 2]),
      instance: new Example(3),
    }),
    callSignature("tool", {
      instance: new Example(3),
      typed: new Uint16Array([1, 2]),
      date: new Date("2024-01-01T00:00:00.000Z"),
    })
  );
  assert.notEqual(
    callSignature("tool", new Float32Array([NaN])),
    callSignature("tool", new Float32Array([Infinity]))
  );
});

test("rejects unsupported Map, Set, symbols, and accessors clearly", () => {
  assert.throws(() => callSignature("tool", new Map()), /unsupported Map/i);
  assert.throws(() => callSignature("tool", new Set()), /unsupported Set/i);
  assert.throws(() => callSignature("tool", Symbol("x")), /unsupported symbol/i);
  assert.throws(
    () => callSignature("tool", { get value() { return 1; } }),
    /unsupported accessor property/i
  );
});

test("distinguishes non-enumerable values and empty objects", () => {
  const hiddenOne = {};
  const hiddenTwo = {};
  Object.defineProperty(hiddenOne, "state", { value: 1 });
  Object.defineProperty(hiddenTwo, "state", { value: 2 });
  assert.notEqual(callSignature("tool", hiddenOne), callSignature("tool", hiddenTwo));
  assert.notEqual(callSignature("tool", {}), callSignature("tool", hiddenOne));
});

test("distinguishes enumerable and non-enumerable properties", () => {
  const visible = { state: 1 };
  const hidden = {};
  Object.defineProperty(hidden, "state", { value: 1, enumerable: false });
  assert.notEqual(callSignature("tool", visible), callSignature("tool", hidden));
});

test("rejects non-enumerable getters and setters without invoking them", () => {
  for (const kind of ["get", "set"]) {
    let invoked = false;
    const value = {};
    Object.defineProperty(value, "hidden", {
      enumerable: false,
      [kind]() { invoked = true; },
    });
    assert.throws(() => callSignature("tool", value), /unsupported accessor property/i);
    assert.equal(invoked, false);
  }
});

test("class instances include hidden own state", () => {
  class Secret {
    constructor(value) {
      Object.defineProperty(this, "value", { value });
    }
  }
  assert.notEqual(callSignature("tool", new Secret(1)), callSignature("tool", new Secret(2)));
  assert.notEqual(callSignature("tool", new Secret(1)), callSignature("tool", {}));
});

test("rejects every invalid LoopGuard option value", () => {
  const invalidValues = [null, "2", NaN, -1, 1.5]; // 0 is handled separately
  for (const key of ["maxCalls", "repeatThreshold", "stagnationThreshold"]) {
    for (const value of invalidValues) {
      assert.throws(() => new LoopGuard({ [key]: value }), /non-negative integer/i);
    }
  }
  
  // Test that 0 is invalid for maxCalls, repeatThreshold, stagnationThreshold, cycleThreshold
  for (const key of ["maxCalls", "repeatThreshold", "stagnationThreshold", "cycleThreshold"]) {
     assert.throws(() => new LoopGuard({ [key]: 0 }), /positive integer/i);
  }

  assert.throws(() => new LoopGuard(null), /must be an object/i);
  assert.throws(() => new LoopGuard({ unexpected: 1 }), /unknown LoopGuard option/i);
});

test("option validation ignores inherited properties", () => {
  const inherited = {
    maxCalls: 0,
    repeatThreshold: 1,
    unexpected: true,
  };
  const options = Object.create(inherited);

  assert.doesNotThrow(() => new LoopGuard(options));

  const guard = new LoopGuard(options);
  assert.equal(guard.summary().budgetRemaining, 50);
});

test("rejects invalid maxSignatureLength values", () => {
  const invalidValues = [null, "200000", NaN, -1, 1.5];
  for (const value of invalidValues) {
    assert.throws(
      () => new LoopGuard({ maxSignatureLength: value }),
      /non-negative integer/i,
      `expected maxSignatureLength: ${String(value)} to be rejected`
    );
  }

  // Unlike maxCycleLength, 0 is invalid for maxSignatureLength.
  assert.throws(() => new LoopGuard({ maxSignatureLength: 0 }), /positive integer/i);
});

test("rejects invalid maxCycleLength values", () => {
  const invalidValues = [null, "10", NaN, -1, 1.5];
  for (const value of invalidValues) {
    assert.throws(
      () => new LoopGuard({ maxCycleLength: value }),
      /non-negative integer/i,
      `expected maxCycleLength: ${String(value)} to be rejected`
    );
  }

  // maxCycleLength === 1 is the one positive integer that's still invalid
  // (cycle detection needs at least a length-2 sequence to compare).
  assert.throws(() => new LoopGuard({ maxCycleLength: 1 }), /0 or at least 2/i);
});

test("deeply nested values fail with a clear validation error", () => {
  let value = {};
  for (let index = 0; index < 110; index += 1) value = { child: value };
  assert.throws(() => callSignature("tool", value), /maximum supported nesting depth/i);
});

test("tracking remains bounded by maxCalls", () => {
  const guard = new LoopGuard({ maxCalls: 2, stagnationThreshold: 10 });
  for (let index = 0; index < 20; index += 1) {
    guard.afterCall("tool", { index }, { index });
  }
  assert.ok(guard.uniqueSignatures.size <= 2);
});

test("memory tracking remains bounded by configured call and history limits", () => {
  const guard = new LoopGuard({
    maxCalls: 3,
    maxCycleLength: 2,
    cycleThreshold: 2,
    repeatThreshold: 10,
    stagnationThreshold: 10,
  });

  for (let index = 0; index < 20; index += 1) {
    guard.afterCall(`tool-${index}`, { index }, { index });
  }

  const summary = guard.summary();
  assert.equal(summary.totalCalls, 3);
  assert.equal(summary.uniqueCallSignatures, 3);
  assert.equal(summary.budgetRemaining, 0);
  assert.equal(summary.blockedCalls, 17);
  assert.deepEqual(summary.callsByTool, { "tool-0": 1, "tool-1": 1, "tool-2": 1 });
  assert.ok(guard.callHistory.length <= 4);
  assert.ok(guard.recentSignatures.length === 0);
});

test("detects cyclic patterns (A B C A B C)", () => {
  const guard = new LoopGuard({ maxCycleLength: 10, cycleThreshold: 2 });
  
  guard.afterCall("toolA", {}, "resA");
  guard.afterCall("toolB", {}, "resB");
  guard.afterCall("toolC", {}, "resC");
  
  guard.afterCall("toolA", {}, "resA");
  guard.afterCall("toolB", {}, "resB");
  
  // The next call will complete the cycle A B C A B C
  const check = guard.afterCall("toolC", {}, "resC");
  assert.equal(check.allowed, false);
  assert.equal(check.code, "CYCLE_DETECTED");
  assert.equal(check.stagnant, false);
});

test("allows custom signature and resultSignature hooks", () => {
  const guard = new LoopGuard({
    signature: (tool, args) => `CUSTOM-${tool}`,
    resultSignature: (res) => `CUSTOM-RES-${res}`
  });
  
  // The custom signature ignores args, so different args still look like a repeat
  guard.afterCall("testTool", { id: 1 }, "res");
  guard.afterCall("testTool", { id: 2 }, "res");
  
  const check = guard.beforeCall("testTool", { id: 3 });
  assert.equal(check.allowed, false);
  assert.equal(check.code, "REPEATED_CALL");
});

test("onDecision hook fires for all calls", () => {
  let decisionCount = 0;
  const guard = new LoopGuard({
    onDecision: (decision) => {
      decisionCount++;
    }
  });
  
  guard.beforeCall("tool", {});
  guard.afterCall("tool", {}, "res");
  
  assert.equal(decisionCount, 2);
});

test("onDecision callback exceptions remain non-fatal", () => {
  const guard = new LoopGuard({
    onDecision: () => {
      throw new Error("observer failed");
    }
  });

  assert.doesNotThrow(() => {
    const decision = guard.beforeCall("tool", {});
    assert.equal(decision.code, "OK");
  });
});

test("onDecision blocks same-instance reset re-entry", () => {
  let reentryError;
  const guard = new LoopGuard({
    onDecision: () => {
      try {
        guard.reset();
      } catch (err) {
        reentryError = err;
      }
    }
  });

  guard.afterCall("tool", {}, "res");

  assert.match(reentryError?.message, /reset\(\) cannot be called.*onDecision/i);
  assert.equal(guard.summary().totalCalls, 1);
});

test("onDecision blocks same-instance beforeCall re-entry", () => {
  let reentryError;
  const guard = new LoopGuard({
    onDecision: () => {
      try {
        guard.beforeCall("nested", {});
      } catch (err) {
        reentryError = err;
      }
    }
  });

  const decision = guard.beforeCall("tool", {});

  assert.equal(decision.code, "OK");
  assert.match(reentryError?.message, /beforeCall\(\) cannot be called.*onDecision/i);
});

test("onDecision blocks same-instance afterCall re-entry", () => {
  let reentryError;
  const guard = new LoopGuard({
    onDecision: () => {
      try {
        guard.afterCall("nested", {}, "res");
      } catch (err) {
        reentryError = err;
      }
    }
  });

  guard.afterCall("tool", {}, "res");

  assert.match(reentryError?.message, /afterCall\(\) cannot be called.*onDecision/i);
  assert.equal(guard.summary().totalCalls, 1);
});

test("onDecision may use a different LoopGuard instance", () => {
  const other = new LoopGuard();
  const guard = new LoopGuard({
    onDecision: () => {
      other.afterCall("nested", {}, "res");
    }
  });

  guard.beforeCall("tool", {});

  assert.equal(other.summary().totalCalls, 1);
});

test("afterCall enforces budget exhaustion", () => {
  const guard = new LoopGuard({ maxCalls: 1 });
  guard.afterCall("search", { q: "a" }, { ok: true });
  const check = guard.afterCall("search", { q: "b" }, { ok: true });
  assert.equal(check.allowed, false);
  assert.equal(check.code, "BUDGET_EXHAUSTED");
  
  const summary = guard.summary();
  assert.equal(summary.totalCalls, 1);
});

test("custom signature hooks are bounded by maxSignatureLength", () => {
  const guard = new LoopGuard({
    maxSignatureLength: 10,
    repeatThreshold: 2,
    signature: () => "A".repeat(100)
  });
  assert.equal(guard.afterCall("tool", { id: 1 }, "res").code, "OK");
  const check = guard.beforeCall("tool", { id: 2 });
  assert.equal(check.code, "REPEATED_CALL");
});

test("RegExp instances are explicitly encoded", () => {
  assert.notEqual(callSignature("t", /a/g), callSignature("t", /b/g));
  assert.notEqual(callSignature("t", /a/g), callSignature("t", /a/i));
});

test("unknown native built-ins are rejected", () => {
  assert.throws(() => callSignature("t", Promise.resolve(1)), /unsupported native built-in Promise/i);
});

test("toolName validation rejects non-strings", () => {
  const guard = new LoopGuard();
  assert.throws(() => guard.beforeCall(123, {}), /toolName must be a non-empty string/i);
  assert.throws(() => guard.afterCall("", {}, "res"), /toolName must be a non-empty string/i);
});

test("changing results do not form a cycle", () => {
  const guard = new LoopGuard({ maxCycleLength: 10, cycleThreshold: 2 });
  guard.afterCall("toolA", {}, "r1");
  guard.afterCall("toolB", {}, "r1");
  guard.afterCall("toolA", {}, "r2");
  const check = guard.afterCall("toolB", {}, "r2");
  assert.equal(check.allowed, true);
});

test("delimiter characters cannot merge cycle entries", () => {
  const guard = new LoopGuard({
    maxCycleLength: 10,
    cycleThreshold: 2,
    signature: (t, args) => args.sig,
    resultSignature: (res) => res
  });
  
  guard.afterCall("t", { sig: "a::b" }, "c");
  guard.afterCall("t", { sig: "d" }, "e::f");
  guard.afterCall("t", { sig: "a" }, "b::c");
  const check = guard.afterCall("t", { sig: "d::e" }, "f");
  assert.equal(check.allowed, true);
});

test("identical pairs are not reported as a length-two cycle", () => {
  const guard = new LoopGuard({
    maxCycleLength: 2,
    cycleThreshold: 2,
    stagnationThreshold: 10,
    repeatThreshold: 10,
  });
  guard.afterCall("t", {}, "A");
  guard.afterCall("t", {}, "A");
  guard.afterCall("t", {}, "A");
  const check = guard.afterCall("t", {}, "A");
  assert.equal(check.code, "OK");
});

test("maxCycleLength must be zero or at least two", () => {
  assert.throws(
    () => new LoopGuard({ maxCycleLength: 1 }),
    /0 or at least 2/i
  );
});

test("maxCycleLength accepts its documented upper bound (1000)", () => {
  assert.doesNotThrow(() => new LoopGuard({ maxCycleLength: 1000 }));

  const guard = new LoopGuard({ maxCycleLength: 1000, cycleThreshold: 2 });
  guard.afterCall("toolA", {}, "resA");
  guard.afterCall("toolB", {}, "resB");
  const check = guard.afterCall("toolA", {}, "resA");
  const check2 = guard.afterCall("toolB", {}, "resB");
  assert.equal(check.allowed, true);
  assert.equal(check2.code, "CYCLE_DETECTED");
});

test("only documented LoopGuard methods are publicly callable on the prototype", () => {
  assert.deepEqual(
    Object.getOwnPropertyNames(LoopGuard.prototype).sort(),
    [
      "afterCall",
      "afterError",
      "beforeCall",
      "constructor",
      "report",
      "reset",
      "run",
      "summary",
      "toJSON",
    ].sort()
  );
});

test("maxCycleLength rejects values above the documented maximum (1000)", () => {
  assert.throws(
    () => new LoopGuard({ maxCycleLength: 1001 }),
    /must not exceed 1000/i
  );
  assert.throws(
    () => new LoopGuard({ maxCycleLength: 5000 }),
    /must not exceed 1000/i
  );
});

test("maxCycleLength of 0 still disables cycle detection", () => {
  const guard = new LoopGuard({ maxCycleLength: 0, cycleThreshold: 2, stagnationThreshold: 10, repeatThreshold: 10 });
  for (let i = 0; i < 6; i += 1) {
    guard.afterCall("toolA", {}, "resA");
    guard.afterCall("toolB", {}, "resB");
  }
  assert.equal(guard.callHistory.length, 0);
});

test("maxCycleLength of 2 (minimum enabled value) still detects cycles", () => {
  const guard = new LoopGuard({ maxCycleLength: 2, cycleThreshold: 2 });
  guard.afterCall("toolA", {}, "resA");
  const check = guard.afterCall("toolB", {}, "resB");
  assert.equal(check.allowed, true);
  guard.afterCall("toolA", {}, "resA");
  const check2 = guard.afterCall("toolB", {}, "resB");
  assert.equal(check2.allowed, false);
  assert.equal(check2.code, "CYCLE_DETECTED");
});

test("cycle detection implementation starts at length two", () => {
  const source = readFileSync(new URL("../src/loop-guard.js", import.meta.url), "utf8");
  assert.match(source, /for \(let len = 2; len <= maxDetectableLength; len\+\+\)/);
  assert.doesNotMatch(source, /for \(let len = 1; len <= maxDetectableLength; len\+\+\)/);
});

test("cycleThreshold three requires three complete repetitions", () => {
  const guard = new LoopGuard({ maxCycleLength: 10, cycleThreshold: 3 });
  guard.afterCall("A", {}, "r");
  guard.afterCall("B", {}, "r");
  guard.afterCall("A", {}, "r");
  const check1 = guard.afterCall("B", {}, "r");
  assert.equal(check1.allowed, true);
  
  guard.afterCall("A", {}, "r");
  const check2 = guard.afterCall("B", {}, "r");
  assert.equal(check2.allowed, false);
  assert.equal(check2.code, "CYCLE_DETECTED");
});

test("reference model agrees across deterministic generated call sequences", () => {
  function createRandom(seed) {
    return () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
  }

  class ReferenceModel {
    constructor(options) {
      this.options = options;
      this.totalCalls = 0;
      this.lastSignature = null;
      this.repeatCount = 0;
      this.lastResultCallSignature = null;
      this.lastResultSignature = null;
      this.stagnantCount = 0;
      this.history = [];
    }

    beforeCall(toolName, args) {
      if (this.totalCalls >= this.options.maxCalls) return "BUDGET_EXHAUSTED";
      const signature = this.options.signature(toolName, args);
      if (
        signature === this.lastSignature &&
        this.repeatCount + 1 >= this.options.repeatThreshold
      ) {
        return "REPEATED_CALL";
      }
      return "OK";
    }

    afterCall(toolName, args, result) {
      if (this.totalCalls >= this.options.maxCalls) return "BUDGET_EXHAUSTED";

      this.totalCalls += 1;
      const signature = this.options.signature(toolName, args);
      const resultSignature = this.options.resultSignature(result);
      this.repeatCount =
        signature === this.lastSignature ? this.repeatCount + 1 : 1;
      this.lastSignature = signature;

      this.stagnantCount =
        signature === this.lastResultCallSignature &&
        resultSignature === this.lastResultSignature
          ? this.stagnantCount + 1
          : 1;
      this.lastResultCallSignature = signature;
      this.lastResultSignature = resultSignature;

      if (this.options.maxCycleLength > 0) {
        this.history.push({ signature, resultSignature });
        const limit = this.options.maxCycleLength * this.options.cycleThreshold;
        if (this.history.length > limit) this.history.shift();
      }

      if (this.stagnantCount >= this.options.stagnationThreshold) {
        return "STAGNANT_RESULT";
      }

      if (this.options.maxCycleLength > 0) {
        const maxDetectableLength = Math.min(
          this.options.maxCycleLength,
          Math.floor(this.history.length / this.options.cycleThreshold)
        );

        for (let len = 2; len <= maxDetectableLength; len++) {
          const sequence = this.history.slice(this.history.length - len);
          const isLengthOnePattern = sequence.every(
            (entry) =>
              entry.signature === sequence[0].signature &&
              entry.resultSignature === sequence[0].resultSignature
          );
          if (isLengthOnePattern) continue;

          let isCycle = true;
          for (let repeat = 1; repeat < this.options.cycleThreshold; repeat++) {
            const offset = this.history.length - len * (repeat + 1);
            for (let index = 0; index < len; index++) {
              const left = this.history[offset + index];
              const right = sequence[index];
              if (
                left.signature !== right.signature ||
                left.resultSignature !== right.resultSignature
              ) {
                isCycle = false;
                break;
              }
            }
            if (!isCycle) break;
          }
          if (isCycle) return "CYCLE_DETECTED";
        }
      }

      return "OK";
    }
  }

  const signature = (toolName, args) => `${toolName}:${JSON.stringify(args)}`;
  const resultSignature = (result) => JSON.stringify(result);

  for (const seed of [11, 29, 101, 20260721]) {
    const random = createRandom(seed);
    for (let caseIndex = 0; caseIndex < 100; caseIndex++) {
      const options = {
        maxCalls: 4 + Math.floor(random() * 12),
        repeatThreshold: 2 + Math.floor(random() * 3),
        stagnationThreshold: 2 + Math.floor(random() * 3),
        maxCycleLength: random() < 0.4 ? 0 : 2 + Math.floor(random() * 5),
        cycleThreshold: 2 + Math.floor(random() * 2),
        signature,
        resultSignature,
      };
      const guard = new LoopGuard(options);
      const model = new ReferenceModel(options);

      for (let step = 0; step < 40; step++) {
        const toolName = `tool-${Math.floor(random() * 4)}`;
        const args = { value: Math.floor(random() * 3), phase: step % 3 };
        const result = { value: Math.floor(random() * 3), phase: step % 2 };
        const before = guard.beforeCall(toolName, args).code;
        assert.equal(before, model.beforeCall(toolName, args));

        if (before === "OK") {
          const after = guard.afterCall(toolName, args, result).code;
          assert.equal(after, model.afterCall(toolName, args, result));
        }
      }
    }
  }
});

test("cycle history remains bounded", () => {
  const guard = new LoopGuard({ maxCycleLength: 5, cycleThreshold: 2 });
  for (let i = 0; i < 20; i++) {
    guard.afterCall(`t${i}`, {}, `r${i}`);
  }
  assert.ok(guard.callHistory.length <= 10);
});

test("custom result signatures are bounded", () => {
  const guard = new LoopGuard({
    maxSignatureLength: 10,
    resultSignature: () => "R".repeat(100)
  });
  assert.equal(guard.afterCall("tool", {}, { id: 1 }).code, "OK");
  assert.equal(guard.afterCall("tool", {}, { id: 2 }).code, "STAGNANT_RESULT");
});

test("constructor getters are rejected without invocation", () => {
  let invoked = false;
  const proto = {};
  Object.defineProperty(proto, "constructor", {
    get() {
      invoked = true;
      return Object;
    },
  });
  const instance = Object.create(proto);
  
  assert.throws(() => callSignature("t", instance), /Unsupported object prototype/i);
  assert.equal(invoked, false);
});

test("oversized tool names do not remain in stored signatures", () => {
  const guard = new LoopGuard({ maxSignatureLength: 10 });
  guard.afterCall("A".repeat(100000), {}, "res");
  const [storedSignature] = guard.uniqueSignatures;
  assert.ok(storedSignature.length < 200);
});

test("cross-realm Date values remain distinct", () => {
  const first = vm.runInNewContext("new Date(0)");
  const second = vm.runInNewContext("new Date(1000)");

  assert.notEqual(
    callSignature("tool", first),
    callSignature("tool", second)
  );
});

test("cross-realm RegExp values remain distinct", () => {
  const first = vm.runInNewContext("/alpha/g");
  const second = vm.runInNewContext("/beta/i");

  assert.notEqual(
    callSignature("tool", first),
    callSignature("tool", second)
  );
});

test("cross-realm Map, Set, and DataView are rejected", () => {
  const map = vm.runInNewContext("new Map([[1, 2]])");
  const set = vm.runInNewContext("new Set([1])");
  const view = vm.runInNewContext(
    "new DataView(new ArrayBuffer(4))"
  );

  assert.throws(() => callSignature("tool", map), /Map/);
  assert.throws(() => callSignature("tool", set), /Set/);
  assert.throws(() => callSignature("tool", view), /DataView/);
});

test("URL and URLSearchParams are explicitly supported", () => {
  assert.notEqual(
    callSignature("tool", new URL("https://example.com/first")),
    callSignature("tool", new URL("https://example.com/second"))
  );
  assert.notEqual(
    callSignature("tool", new URLSearchParams("page=1")),
    callSignature("tool", new URLSearchParams("page=2"))
  );
});

test("Headers is rejected as an unsupported web built-in", () => {
  assert.throws(
    () => callSignature("tool", new Headers({ a: "1" })),
    /Unsupported built-in Headers/i
  );
});

test("URL works consistently on supported Node versions", () => {
  assert.notEqual(
    callSignature(
      "tool",
      new URL("https://example.com/first")
    ),
    callSignature(
      "tool",
      new URL("https://example.com/second")
    )
  );
});

test("URL custom properties remain distinct", () => {
  const first = new URL("https://example.com/");
  const second = new URL("https://example.com/");

  first.extra = 1;
  second.extra = 2;

  assert.notEqual(
    callSignature("tool", first),
    callSignature("tool", second)
  );
});

test("URLSearchParams custom properties remain distinct", () => {
  const first = new URLSearchParams("page=1");
  const second = new URLSearchParams("page=1");

  first.extra = 1;
  second.extra = 2;

  assert.notEqual(
    callSignature("tool", first),
    callSignature("tool", second)
  );
});
