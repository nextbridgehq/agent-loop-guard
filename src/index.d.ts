export function stableStringify(value: unknown): string;
export function hashSignature(input: string): string;
export function callSignature(name: string, args: unknown): string;

export type SuggestedAction = "stop" | "change_approach";

export type DecisionCode =
  | "OK"
  | "BUDGET_EXHAUSTED"
  | "TOOL_BUDGET_EXHAUSTED"
  | "TIME_BUDGET_EXHAUSTED"
  | "REPEATED_CALL"
  | "REPEATED_CALL_IN_WINDOW"
  | "STAGNANT_RESULT"
  | "CYCLE_DETECTED";

export type BeforeCallBlockCode =
  | "BUDGET_EXHAUSTED"
  | "TOOL_BUDGET_EXHAUSTED"
  | "TIME_BUDGET_EXHAUSTED"
  | "REPEATED_CALL"
  | "REPEATED_CALL_IN_WINDOW";

export type AfterCallBlockCode =
  | "BUDGET_EXHAUSTED"
  | "STAGNANT_RESULT"
  | "CYCLE_DETECTED";

export type WarningCode =
  | "APPROACHING_BUDGET"
  | "APPROACHING_TOOL_BUDGET"
  | "APPROACHING_REPEAT_LIMIT"
  | "APPROACHING_STAGNATION";

/** Non-blocking early signal attached to an allowed decision. */
export interface GuardWarning {
  code: WarningCode;
  message: string;
}

export type AllowedBeforeCallDecision = {
  allowed: true;
  code: "OK";
  reason: null;
  suggestedAction: null;
  suggestionDetail: null;
  warnings: GuardWarning[];
};

export type BlockedBeforeCallDecision = {
  allowed: false;
  code: BeforeCallBlockCode;
  reason: string;
  suggestedAction: SuggestedAction;
  suggestionDetail: string;
  warnings: GuardWarning[];
};

export type BeforeCallDecision =
  | AllowedBeforeCallDecision
  | BlockedBeforeCallDecision;

export type AllowedAfterCallDecision = {
  allowed: true;
  code: "OK";
  stagnant: false;
  reason: null;
  suggestedAction: null;
  suggestionDetail: null;
  warnings: GuardWarning[];
};

export type BlockedAfterCallDecision =
  | {
      allowed: false;
      code: "STAGNANT_RESULT";
      stagnant: true;
      reason: string;
      suggestedAction: "change_approach";
      suggestionDetail: string;
      warnings: GuardWarning[];
    }
  | {
      allowed: false;
      code: "BUDGET_EXHAUSTED" | "CYCLE_DETECTED";
      stagnant: false;
      reason: string;
      suggestedAction: SuggestedAction;
      suggestionDetail: string;
      warnings: GuardWarning[];
    };

export type AfterCallDecision =
  | AllowedAfterCallDecision
  | BlockedAfterCallDecision;

export type GuardDecision = BeforeCallDecision | AfterCallDecision;

/** Outcome of LoopGuard#run(). */
export type RunOutcome<T> =
  | {
      executed: false;
      blocked: true;
      phase: "before";
      decision: BlockedBeforeCallDecision;
      before: BlockedBeforeCallDecision;
      after: null;
      result: undefined;
    }
  | {
      executed: true;
      blocked: false;
      phase: null;
      decision: AllowedAfterCallDecision;
      before: AllowedBeforeCallDecision;
      after: AllowedAfterCallDecision;
      result: T;
    }
  | {
      executed: true;
      blocked: true;
      phase: "after";
      decision: BlockedAfterCallDecision;
      before: AllowedBeforeCallDecision;
      after: BlockedAfterCallDecision;
      result: T;
    };

export interface LoopGuardOptions {
  /** Hard ceiling on total tool calls in a run. Default 50. */
  maxCalls?: number;
  /** Optional per-tool ceilings, e.g. `{ search: 10 }`. Default null. */
  maxCallsPerTool?: Record<string, number> | null;
  /** Wall-clock ceiling in ms, measured from the first call. 0 disables. Default 0. */
  maxDurationMs?: number;
  /** Consecutive identical calls before blocking. Minimum 2. Default 3. */
  repeatThreshold?: number;
  /** Consecutive identical call+result pairs before blocking. Minimum 2. Default 2. */
  stagnationThreshold?: number;
  /** Sliding window of recent calls used for non-consecutive repeats. 0 disables. Default 0. */
  windowSize?: number;
  /** Identical calls allowed within the window before blocking. Default 3. */
  maxRepeatsInWindow?: number;
  /** Signatures longer than this are hashed before being retained. Default 200000. */
  maxSignatureLength?: number;
  /** Longest sequence tracked for cycle detection. 0 disables, max 1000. Default 0. */
  maxCycleLength?: number;
  /** How many times a sequence must repeat to count as a cycle. Default 2. */
  cycleThreshold?: number;
  /** Emit non-blocking early warnings on allowed decisions. Default true. */
  warn?: boolean;
  /** Warn when this many calls or fewer remain in a budget. 0 disables. Default 5. */
  budgetWarnAt?: number;
  signature?: ((toolName: string, args: unknown) => string) | null;
  resultSignature?: ((result: unknown) => string) | null;
  errorSignature?: ((error: unknown) => string) | null;
  onDecision?: ((decision: Readonly<GuardDecision>) => void) | null;
  /** Clock override for testing, returning milliseconds. Defaults to Date.now. */
  now?: (() => number) | null;
}

export interface LoopGuardSummary {
  totalCalls: number;
  uniqueCallSignatures: number;
  budgetRemaining: number;
  blockedCalls: number;
  elapsedMs: number;
  callsByTool: Record<string, number>;
  decisionsByCode: Partial<Record<DecisionCode, number>>;
}

/** Serialized run state produced by LoopGuard#toJSON(). */
export interface LoopGuardState {
  version: 1;
  totalCalls: number;
  uniqueSignatures: string[];
  consecutiveRepeatCount: number;
  lastSignature: string | null;
  lastResultCallSignature: string | null;
  lastResultSignature: string | null;
  consecutiveResultCount: number;
  callHistory: Array<[string, string]>;
  recentSignatures: string[];
  callsByTool: Record<string, number>;
  decisionsByCode: Partial<Record<DecisionCode, number>>;
  blockedCalls: number;
  elapsedMs: number;
}

export class LoopGuard {
  constructor(options?: LoopGuardOptions);
  beforeCall(name: string, args: unknown): BeforeCallDecision;
  afterCall(name: string, args: unknown, result: unknown): AfterCallDecision;
  afterError(name: string, args: unknown, error: unknown): AfterCallDecision;
  run<T>(
    name: string,
    args: unknown,
    executor: () => T | Promise<T>
  ): Promise<RunOutcome<Awaited<T>>>;
  summary(): LoopGuardSummary;
  report(): string;
  reset(): void;
  toJSON(): LoopGuardState;
  static fromJSON(state: LoopGuardState, options?: LoopGuardOptions): LoopGuard;
}
