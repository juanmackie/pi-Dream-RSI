/** Shared, side-effect-free budget admission for a complete verified promotion. */

export interface AdmissionResources { agentStarts: number; evaluatorRuns: number; wallMs: number; }
export interface AdmissionInput {
  remaining: AdmissionResources;
  /** Expected wall time for one evaluator reading; this is not its kill timeout. */
  expectedReadMs: number;
  gates: number;
  deterministic: boolean;
  /** True when qualified baseline readings can be reused in confirmation. */
  baselineReuse: boolean;
  /** Independent post-apply evaluator readings, normally one score or three durations. */
  postApplyRuns: number;
  search: AdmissionResources;
  /** Agent attempts plus independent review needed for a verified promotion. */
  promotionAgentStarts?: number;
  /** Maximum noisy pairs the confirmation design can use. Defaults to 32. */
  maxConfirmationPairs?: number;
}
export interface AdmissionPlan {
  feasible: boolean;
  reserve: AdmissionResources;
  confirmation: { baselineRuns: number; firstLookPairs: number; firstLookRuns: number; maxPairs: number };
  shortfall: null | { code: "agent-budget" | "confirmation-budget" | "deadline"; requiredAgentStarts: number; requiredEvaluatorRuns: number; requiredWallMs: number };
}

/**
 * Require enough resources for one whole promotion before spending on search.
 * Noisy confirmation admits its first two-pair look independently of the larger
 * maximum sample; unused allowance determines how many later looks can be run.
 */
export function planAdmission(input: AdmissionInput): AdmissionPlan {
  const positive = (value: number, label: string): void => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  };
  positive(input.remaining.agentStarts, "remaining.agentStarts");
  positive(input.remaining.evaluatorRuns, "remaining.evaluatorRuns");
  positive(input.remaining.wallMs, "remaining.wallMs");
  positive(input.expectedReadMs, "expectedReadMs");
  positive(input.gates, "gates");
  positive(input.postApplyRuns, "postApplyRuns");
  positive(input.search.agentStarts, "search.agentStarts");
  positive(input.search.evaluatorRuns, "search.evaluatorRuns");
  positive(input.search.wallMs, "search.wallMs");
  const firstLookPairs = input.deterministic ? 1 : 2;
  const baselineRuns = input.deterministic || input.baselineReuse ? 0 : 5;
  const firstLookRuns = baselineRuns + firstLookPairs * 2;
  const maxConfirmationPairs = input.deterministic ? 1 : Math.max(2, Math.floor((input.maxConfirmationPairs ?? 32) / 2) * 2);
  const availableForConfirmation = input.remaining.evaluatorRuns - input.search.evaluatorRuns - input.gates - input.postApplyRuns;
  const maxPairs = input.deterministic ? 1 : Math.max(firstLookPairs, Math.min(maxConfirmationPairs, Math.max(0, Math.floor((availableForConfirmation - baselineRuns) / 4) * 2)));
  const confirmationRuns = baselineRuns + maxPairs * 2;
  const reserve: AdmissionResources = {
    agentStarts: input.promotionAgentStarts ?? 3,
    evaluatorRuns: input.gates + input.postApplyRuns + confirmationRuns,
    wallMs: input.expectedReadMs * (input.gates + input.postApplyRuns + confirmationRuns) + input.search.wallMs,
  };
  const requiredAgentStarts = input.search.agentStarts + reserve.agentStarts;
  const requiredEvaluatorRuns = input.search.evaluatorRuns + input.gates + input.postApplyRuns + firstLookRuns;
  const requiredWallMs = input.search.wallMs + input.expectedReadMs * (input.gates + input.postApplyRuns + firstLookRuns);
  let code: "agent-budget" | "confirmation-budget" | "deadline" | undefined;
  if (input.remaining.agentStarts < requiredAgentStarts) code = "agent-budget";
  else if (input.remaining.evaluatorRuns < requiredEvaluatorRuns) code = "confirmation-budget";
  else if (input.remaining.wallMs < requiredWallMs) code = "deadline";
  return {
    feasible: code === undefined,
    reserve,
    confirmation: { baselineRuns, firstLookPairs, firstLookRuns, maxPairs: input.deterministic ? 1 : Math.max(firstLookPairs, maxPairs) },
    shortfall: code === undefined ? null : { code, requiredAgentStarts, requiredEvaluatorRuns, requiredWallMs },
  };
}
