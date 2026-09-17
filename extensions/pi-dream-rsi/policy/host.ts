/**
 * Host side of the policy contract: the `question` object a policy talks to.
 *
 * Two modes share one implementation:
 * - `live`   — probing executes real generation-evaluation attempts (host callback).
 * - `replay` — probing deterministically reveals recorded children of a frozen world (paper §3).
 *
 * The host owns the *observed* tree; in replay the full recorded world stays private, which is what
 * makes prefix-only policies enforceable rather than merely requested.
 */

import { DiscoveryTree, ROOT_ID, type CellMeta, type Observation, type TreeNode } from "../engine/tree.ts";
import { _budget_done, type Budget, type CellId, type QuestionView } from "./api.ts";

/** One revealed cell returned by a probe: the cell id plus its outcome record. */
export interface RevealedNode {
  cell: CellId;
  node: Partial<TreeNode>;
}

export type ProbeFn = (cells: CellId[], round: number) => Promise<RevealedNode[]>;

export interface Decision {
  round: number;
  observed: CellId[];
  batch: CellId[];
  revealed: Record<CellId, Observation>;
  best_after: number | null;
}

export interface HostOptions {
  mode: "live" | "replay";
  maxParallelism: number;
  probe: ProbeFn;
  /** Branch indices to materialize as selectable root slots at episode start. */
  slots?: number[];
  /** Live grid definition (branch slots + refinement depth). */
  grid?: { branch_count: number; refine_count: number } | null;
  /** K1 (live) or K2 (replay): the environment stops offering legal cells after this many rounds. */
  maxRounds?: number;
  baselineScore?: number | null;
  refineCount?: number;
}

export class PolicyHost implements QuestionView {
  max_parallelism: number;
  baseline_score: number | null;
  mode: "live" | "replay";
  /** Revealed prefix only — this is what the policy may see. */
  observedTree: DiscoveryTree;
  /** Between-round feedback for `policy_execution_traces.jsonl`; never visible inside `solve()`. */
  decisions: Decision[];

  private probeFn: ProbeFn;
  private slotBranches: number[];
  private grid: { branch_count: number; refine_count: number } | null;
  private refineCountHint: number;
  /** K1/K2 — enforced here so a policy cannot outrun the round limit by ignoring its budget. */
  private maxRounds: number;
  private batchCount: number;
  private probeCount: number;
  private revealed: Set<CellId>;

  constructor(opts: HostOptions) {
    this.mode = opts.mode;
    this.probeFn = opts.probe;
    this.grid = opts.grid ?? null;
    this.max_parallelism = Math.max(1, opts.maxParallelism);
    this.baseline_score = opts.baselineScore ?? null;
    this.slotBranches = opts.slots ?? [];
    this.refineCountHint = opts.refineCount ?? 0;
    this.maxRounds = Math.max(1, opts.maxRounds ?? Number.MAX_SAFE_INTEGER);
    this.observedTree = new DiscoveryTree({ baselineScore: this.baseline_score });
    this.decisions = [];
    this.batchCount = 0;
    this.probeCount = 0;
    this.revealed = new Set();
    this.reset();
  }

  reset(): void {
    this.observedTree = new DiscoveryTree({
      baselineScore: this.baseline_score,
      branchCount: this.grid?.branch_count ?? this.slotBranches.length,
      refineCount: this.grid?.refine_count ?? this.refineCountHint,
    });
    this.batchCount = 0;
    this.probeCount = 0;
    this.revealed = new Set();
    this.decisions = [];
    const branches =
      this.slotBranches.length > 0
        ? this.slotBranches
        : Array.from({ length: Math.max(1, this.grid?.branch_count ?? 1) }, (_, i) => i);
    for (const branch of branches) this.observedTree.addBranchSlot(branch);
  }

  observed(): Record<CellId, Observation> {
    const out: Record<CellId, Observation> = {};
    for (const node of this.observedTree.list()) {
      if (!this.revealed.has(node.meta.cell_id)) continue;
      out[node.meta.cell_id] = this.observedTree.observation(node.meta.cell_id);
    }
    return out;
  }

  legal_actions(): CellId[] {
    if (this.roundsExhausted) return [];
    return this.observedTree.legalActions();
  }

  legal_roots(): CellId[] {
    if (this.roundsExhausted) return [];
    return this.observedTree.unopenedRoots();
  }

  opened_branches(): number[] {
    return this.observedTree.openedBranches();
  }

  meta(cell_id: CellId): CellMeta {
    if (cell_id === ROOT_ID) return { branch: -1, attempt: -1, parent_id: null, seq: 0, tags: ["root"] };
    const node = this.observedTree.get(cell_id);
    if (!node) throw new Error(`illegal cell id: ${cell_id}`);
    return { ...node.meta, tags: [...node.meta.tags] };
  }

  /** The revealed node record for a cell (host-side structural helper, not part of the policy API). */
  node(cell_id: CellId): TreeNode | undefined {
    return this.observedTree.get(cell_id);
  }

  async probe_batch(cells: CellId[], on_reveal?: (o: Observation) => void): Promise<Observation[]> {
    const batch = this.validateBatch(cells);
    const round = this.batchCount + 1;
    const before = this.observedTree.list().map((n) => n.meta.cell_id);
    // The round is in flight while the batch runs, so counters read correctly inside `on_reveal`.
    this.batchCount = round;
    const records = await this.probeFn(batch, round);
    const revealed: Record<CellId, Observation> = {};
    const produced: Observation[] = [];
    for (const record of records) {
      this.materialize(record.cell);
      this.observedTree.setOutcome(record.cell, record.node);
      this.revealed.add(record.cell);
      const observation = this.observedTree.observation(record.cell);
      revealed[record.cell] = observation;
      produced.push(observation);
      this.probeCount += 1;
      on_reveal?.(observation);
    }
    this.decisions.push({ round, observed: before, batch, revealed, best_after: this.best_score });
    return produced;
  }

  get rounds_used(): number {
    return this.batchCount;
  }

  get probes_used(): number {
    return this.probeCount;
  }

  get best_score(): number | null {
    return this.observedTree.bestScore();
  }

  get best_so_far(): number | null {
    return this.best_score;
  }

  get budget_spent(): number {
    return this.probeCount;
  }

  budget_done(budget?: Budget | null): boolean {
    return _budget_done(this, budget);
  }

  get roundsExhausted(): boolean {
    return this.batchCount >= this.maxRounds;
  }

  // -- internals -----------------------------------------------------------

  /** Attach a revealed cell that the observed tree has not seen yet (replay reveals recorded children). */
  private materialize(cell: CellId): void {
    if (this.observedTree.has(cell)) return;
    const parsed = /^b(\d+)a(\d+)$/.exec(cell);
    if (!parsed) throw new Error(`malformed cell id: ${cell}`);
    const branch = Number(parsed[1]);
    const attempt = Number(parsed[2]);
    if (attempt === 0) {
      this.observedTree.addBranchSlot(branch);
      return;
    }
    const parentId = `b${branch}a${attempt - 1}`;
    if (!this.observedTree.has(parentId)) throw new Error(`revealed cell ${cell} has no revealed parent`);
    this.observedTree.addChild(parentId, branch, attempt);
  }

  private validateBatch(cells: CellId[]): CellId[] {
    if (this.roundsExhausted) {
      throw new Error(`round limit reached: ${this.batchCount} of ${this.maxRounds} decision rounds used`);
    }
    if (!Array.isArray(cells)) throw new Error("batch must be an array of cell ids");
    if (cells.length === 0) throw new Error("empty batch: a policy must stop by returning no batches");
    if (cells.length > this.max_parallelism) {
      throw new Error(`batch of ${cells.length} exceeds max_parallelism ${this.max_parallelism}`);
    }
    const legal = new Set(this.observedTree.legalActions());
    const seen = new Set<CellId>();
    for (const id of cells) {
      if (typeof id !== "string" || !id) throw new Error("batch contains a non-string cell id");
      if (seen.has(id)) throw new Error(`duplicate cell id in batch: ${id}`);
      seen.add(id);
      if (id === ROOT_ID) throw new Error("the root cell is not itself an action; select a root slot instead");
      if (!legal.has(id)) throw new Error(`illegal cell id for the current prefix: ${id}`);
    }
    // A parent and its child must never travel in the same batch.
    for (const id of seen) {
      const node = this.observedTree.get(id);
      if (node?.meta.parent_id && seen.has(node.meta.parent_id)) {
        throw new Error(`batch contains both a parent and its child: ${node.meta.parent_id} + ${id}`);
      }
    }
    return [...seen];
  }
}
