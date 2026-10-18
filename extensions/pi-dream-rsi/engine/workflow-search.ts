/** Bounded MASS-style workflow search over typed, reviewable role contracts. */

export type WorkflowRole = "scout" | "implementer" | "reviewer" | "verifier";
export type WorkflowInstruction = "measure-first" | "minimal-patch" | "adversarial-review" | "independent-reproduction";
export type WorkflowContract = "bottleneck-report" | "patch-and-rationale" | "review-findings" | "reproduction-record";

export interface WorkflowStage {
  id: string;
  role: WorkflowRole;
  instruction: WorkflowInstruction;
  input: WorkflowContract;
  output: WorkflowContract;
  after: string[];
}

export interface ResearchWorkflow {
  version: 1;
  stages: WorkflowStage[];
}

const ROLES: readonly WorkflowRole[] = ["scout", "implementer", "reviewer", "verifier"];
const INSTRUCTIONS: readonly WorkflowInstruction[] = ["measure-first", "minimal-patch", "adversarial-review", "independent-reproduction"];
const CONTRACTS: readonly WorkflowContract[] = ["bottleneck-report", "patch-and-rationale", "review-findings", "reproduction-record"];
const MAX_STAGES = 6;
const MAX_NEIGHBORS = 96;

/** Reject malformed graphs before they can be serialized into an editable policy. */
export function validateResearchWorkflow(value: unknown): ResearchWorkflow {
  if (!value || typeof value !== "object" || (value as ResearchWorkflow).version !== 1
    || !Array.isArray((value as ResearchWorkflow).stages)) throw new Error("workflow schema must be version 1 with a stages array");
  const workflow = value as ResearchWorkflow;
  if (workflow.stages.length < 2 || workflow.stages.length > MAX_STAGES) throw new Error(`workflow must have 2-${MAX_STAGES} stages`);
  const ids = new Set<string>();
  for (const stage of workflow.stages) {
    if (!stage || !/^[a-z][a-z0-9-]{0,23}$/.test(stage.id) || ids.has(stage.id)) throw new Error("workflow stage ids must be unique bounded identifiers");
    ids.add(stage.id);
    if (!ROLES.includes(stage.role) || !INSTRUCTIONS.includes(stage.instruction)
      || !CONTRACTS.includes(stage.input) || !CONTRACTS.includes(stage.output)) throw new Error("workflow uses a role, instruction, or contract outside the allowlist");
    if (!Array.isArray(stage.after) || stage.after.some((id) => typeof id !== "string") || new Set(stage.after).size !== stage.after.length) throw new Error("workflow predecessors must be a unique list");
  }
  for (const stage of workflow.stages) {
    if (stage.after.some((id) => !ids.has(id) || id === stage.id)) throw new Error("workflow contains an unknown or self predecessor");
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  const byId = new Map(workflow.stages.map((stage) => [stage.id, stage]));
  const visit = (id: string): void => {
    if (active.has(id)) throw new Error("workflow graph must be acyclic");
    if (visited.has(id)) return;
    active.add(id);
    for (const parent of byId.get(id)!.after) visit(parent);
    active.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  if (workflow.stages.filter((stage) => stage.after.length === 0).length !== 1) throw new Error("workflow must have exactly one root stage");
  if (!workflow.stages.some((stage) => stage.role === "reviewer") || !workflow.stages.some((stage) => stage.role === "verifier")) {
    throw new Error("workflow must include reviewer and verifier roles");
  }
  return { version: 1, stages: workflow.stages.map((stage) => ({ ...stage, after: [...stage.after].sort() })) };
}

/** Produce single-edit neighbors; callers must evaluate them under a fixed budget. */
export function researchWorkflowNeighbors(input: ResearchWorkflow): ResearchWorkflow[] {
  const base = validateResearchWorkflow(input);
  const out = new Map<string, ResearchWorkflow>();
  const add = (candidate: ResearchWorkflow): void => {
    try {
      const normalized = validateResearchWorkflow(candidate);
      const key = JSON.stringify(normalized);
      if (key !== JSON.stringify(base)) out.set(key, normalized);
    } catch { /* a one-edit mutation that violates the contract is not a candidate */ }
  };
  for (let index = 0; index < base.stages.length; index += 1) {
    const stage = base.stages[index]!;
    for (const role of ROLES) if (role !== stage.role) add({ ...base, stages: base.stages.map((item, i) => i === index ? { ...item, role } : item) });
    for (const instruction of INSTRUCTIONS) if (instruction !== stage.instruction) add({ ...base, stages: base.stages.map((item, i) => i === index ? { ...item, instruction } : item) });
    for (const input of CONTRACTS) if (input !== stage.input) add({ ...base, stages: base.stages.map((item, i) => i === index ? { ...item, input } : item) });
    for (const output of CONTRACTS) if (output !== stage.output) add({ ...base, stages: base.stages.map((item, i) => i === index ? { ...item, output } : item) });
    for (let parent = 0; parent < base.stages.length; parent += 1) {
      if (parent === index) continue;
      const parentId = base.stages[parent]!.id;
      const after = stage.after.includes(parentId) ? stage.after.filter((id) => id !== parentId) : [...stage.after, parentId];
      add({ ...base, stages: base.stages.map((item, i) => i === index ? { ...item, after } : item) });
    }
  }
  return [...out.values()].slice(0, MAX_NEIGHBORS);
}

/** Regularization distance used to keep proposed workflow edits local. */
export function researchWorkflowEditDistance(left: ResearchWorkflow, right: ResearchWorkflow): number {
  const a = validateResearchWorkflow(left);
  const b = validateResearchWorkflow(right);
  const rightById = new Map(b.stages.map((stage) => [stage.id, stage]));
  let distance = Math.abs(a.stages.length - b.stages.length);
  for (const stage of a.stages) {
    const other = rightById.get(stage.id);
    if (!other) { distance += 1; continue; }
    distance += Number(stage.role !== other.role) + Number(stage.instruction !== other.instruction)
      + Number(stage.input !== other.input) + Number(stage.output !== other.output);
    const edges = new Set([...stage.after, ...other.after]);
    distance += [...edges].filter((edge) => stage.after.includes(edge) !== other.after.includes(edge)).length;
  }
  return distance;
}
