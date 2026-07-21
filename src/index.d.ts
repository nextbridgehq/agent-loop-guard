export function stableStringify(value: unknown): string;
export function hashSignature(input: string): string;
export function callSignature(name: string, args: unknown): string;

export type SuggestedAction = "stop" | "change_approach";
export type DecisionCode = "OK" | "BUDGET_EXHAUSTED" | "REPEATED_CALL" | "STAGNANT_RESULT" | "CYCLE_DETECTED";

export type BeforeCallDecision =
  | {
      allowed: true;
      code: "OK";
      reason: null;
      suggestedAction: null;
      suggestionDetail: null;
    }
  | {
      allowed: false;
      code: "BUDGET_EXHAUSTED" | "REPEATED_CALL";
      reason: string;
      suggestedAction: SuggestedAction;
      suggestionDetail: string;
    };

export type AfterCallDecision =
  | {
      allowed: true;
      code: "OK";
      stagnant: false;
      reason: null;
      suggestedAction: null;
      suggestionDetail: null;
    }
  | {
      allowed: false;
      code: "STAGNANT_RESULT";
      stagnant: true;
      reason: string;
      suggestedAction: "change_approach";
      suggestionDetail: string;
    }
  | {
      allowed: false;
      code: "BUDGET_EXHAUSTED" | "CYCLE_DETECTED";
      stagnant: false;
      reason: string;
      suggestedAction: SuggestedAction;
      suggestionDetail: string;
    };

export type GuardDecision = BeforeCallDecision | AfterCallDecision;

export interface LoopGuardOptions {
  maxCalls?: number;
  repeatThreshold?: number;
  stagnationThreshold?: number;
  maxSignatureLength?: number;
  maxCycleLength?: number;
  cycleThreshold?: number;
  signature?: ((toolName: string, args: unknown) => string) | null;
  resultSignature?: ((result: unknown) => string) | null;
  onDecision?: ((decision: GuardDecision) => void) | null;
}

export interface LoopGuardSummary {
  totalCalls: number;
  uniqueCallSignatures: number;
  budgetRemaining: number;
}

export class LoopGuard {
  constructor(options?: LoopGuardOptions);
  beforeCall(name: string, args: unknown): BeforeCallDecision;
  afterCall(name: string, args: unknown, result: unknown): AfterCallDecision;
  summary(): LoopGuardSummary;
  reset(): void;
}
