/**
 * Discovery tree — the structure Dream-RSI explores and replays.
 *
 * Paper (arXiv 2609.14858 §3): a discovery tree is rooted at `r`, the initial workspace state.
 * Every non-root node has exactly one primary parent whose saved workspace it resumes. A node
 * records the outcome of one generation-evaluation attempt. Eligible nodes form
 * `A(T) = {r} ∪ leaves`.
 *
 * Concrete shape used here: the root `r` holds the task baseline; each *branch* is a chain of
 * refinement attempts `b<branch>a<attempt>` whose primary parent is the previous attempt in the
 * branch (the first attempt's parent is `r`). Opening a branch = one independent workspace
 * (paper: "several roots" in a batch).
 */

export const ROOT_ID = "root";

/** `b3a2` = branch 3, refinement attempt 2. */
export function cellId(branch: number, attempt: number): string {
  return `b${branch}a${attempt}`;
}

export interface CellMeta {
  cell_id: string;
  /** Branch index; -1 for the root. */
  branch: number;
  /** Refinement attempt index within the branch; -1 for the root. */
  attempt: number;
  parent_id: string | null;
  /** Creation order — the replay root rule reveals the earliest-created unrevealed branch. */
  seq: number;
  tags: string[];
}


/** One completed (or revealed) generation-evaluation attempt. */
export interface TreeNode {
  meta: CellMeta;
  evaluated: boolean;
  valid: boolean;
  fail_class: string;
  error: string | null;
  /** `s_v` — present only for successful evaluations that reported a number. */
  score: number | null;
  /** Raw evaluator value before `higher_is_better` normalization (diagnostics only). */
  raw_score: number | null;
  /** Workspace snapshot path, relative to the Dream-RSI root. Null when the attempt produced nothing. */
  workspace: string | null;
  /** Path to `proposal.md`, relative to the Dream-RSI root. */
  proposal: string | null;
  artifacts: string[];
  /** Wall-clock ms of the attempt, for status reporting only (never used by replay). */
  duration_ms: number | null;
}

/**
 * Success semantics (paper Appendix B): an evaluated observation with `error == null` and
 * `fail_class == "ok"` is a *successful evaluation* — even when the evaluator's own `valid` flag is
 * false or the counts are unavailable. `valid` therefore stays a separate, task-level notion.
 */
export function isSuccess(o: Pick<TreeNode, "evaluated" | "fail_class" | "error">): boolean {
  return o.evaluated === true && o.error === null && o.fail_class === "ok";
}

/** An unopened branch slot has no outcome yet and is therefore not an opened branch. */
export function isOpened(n: Pick<TreeNode, "evaluated" | "workspace">): boolean {
  return n.evaluated === true || n.workspace !== null;
}

/** What the policy sees for one revealed cell (paper Appendix B, `Observation`). */
export interface Observation {
  branch: number;
  attempt: number;
  score: number | null;
  evaluated: boolean;
  /** The evaluator's task-level validity flag (not the same thing as a successful evaluation). */
  valid: boolean;
  fail_class: string;
  error: string | null;
  delta_vs_baseline: number | null;
  delta_vs_parent: number | null;
  n_valid: number;
  n_total: number;
}

export interface TreeJSON {
  version: 1;
  branch_count: number;
  refine_count: number;
  seq: number;
  baseline_score: number | null;
  cells: TreeNode[];
}

/** Mutable discovery tree with the observation/reveal operations the policy API needs. */
export class DiscoveryTree {
  /** -1 in `meta.branch` for the root. */
  root: TreeNode;
  branchCount: number;
  refineCount: number;
  seq: number;
  cells: Map<string, TreeNode>;

  constructor(opts: { baselineScore?: number | null; branchCount?: number; refineCount?: number } = {}) {
    this.root = {
      meta: { cell_id: ROOT_ID, branch: -1, attempt: -1, parent_id: null, seq: 0, tags: ["root"] },
      evaluated: true,
      valid: typeof opts.baselineScore === "number",
      fail_class: "ok",
      error: null,
      score: opts.baselineScore ?? null,
      raw_score: opts.baselineScore ?? null,
      workspace: null,
      proposal: null,
      artifacts: [],
      duration_ms: null,
    };
    this.branchCount = opts.branchCount ?? 0;
    this.refineCount = opts.refineCount ?? 0;
    this.seq = 1;
    this.cells = new Map();
  }

  get baselineScore(): number | null {
    return this.root.score;
  }

  get(cell: string): TreeNode | undefined {
    return cell === ROOT_ID ? this.root : this.cells.get(cell);
  }

  has(cell: string): boolean {
    return cell === ROOT_ID || this.cells.has(cell);
  }

  /** All revealed non-root cells, in creation order. */
  list(): TreeNode[] {
    return [...this.cells.values()].sort((a, b) => a.meta.seq - b.meta.seq);
  }

  /** Number of revealed non-root nodes = N in the replay objective. */
  get nNonRoot(): number {
    return this.cells.size;
  }

  /** Materialize a not-yet-opened branch slot (a root child with no outcome yet). */
  addBranchSlot(branch: number): TreeNode {
    const id = cellId(branch, 0);
    const existing = this.cells.get(id);
    if (existing) return existing;
    const node: TreeNode = {
      meta: { cell_id: id, branch, attempt: 0, parent_id: ROOT_ID, seq: this.seq++, tags: ["root-slot"] },
      evaluated: false,
      valid: false,
      fail_class: "ok",
      error: null,
      score: null,
      raw_score: null,
      workspace: null,
      proposal: null,
      artifacts: [],
      duration_ms: null,
    };
    this.cells.set(id, node);
    return node;
  }

  /** Register a new refinement child of `parentId` (used by the live phase). */
  addChild(parentId: string, branch: number, attempt: number, tags: string[] = []): TreeNode {
    const id = cellId(branch, attempt);
    const node: TreeNode = {
      meta: { cell_id: id, branch, attempt, parent_id: parentId, seq: this.seq++, tags },
      evaluated: false,
      valid: false,
      fail_class: "ok",
      error: null,
      score: null,
      raw_score: null,
      workspace: null,
      proposal: null,
      artifacts: [],
      duration_ms: null,
    };
    this.cells.set(id, node);
    return node;
  }

  /** Record the outcome of an attempt (live) or the stored outcome of a revealed node (replay). */
  setOutcome(cell: string, outcome: Partial<TreeNode>): TreeNode {
    const node = this.get(cell);
    if (!node) throw new Error(`unknown cell: ${cell}`);
    Object.assign(node, outcome);
    if (outcome.meta) node.meta = { ...node.meta, ...outcome.meta };
    // The evaluator's own validity flag wins; otherwise fall back to evaluation success.
    if (outcome.valid === undefined) node.valid = isSuccess(node);
    return node;
  }

  childrenOf(cell: string): TreeNode[] {
    return this.list().filter((n) => n.meta.parent_id === cell);
  }

  /** Non-root nodes without revealed children. */
  leaves(): TreeNode[] {
    const parents = new Set<string>();
    for (const n of this.cells.values()) if (n.meta.parent_id) parents.add(n.meta.parent_id);
    return this.list().filter((n) => !parents.has(n.meta.cell_id));
  }

  /** `A(T) = {r} ∪ leaves` — ids of eligible cells, creation order with the root last. */
  eligible(): string[] {
    const leaves = this.leaves().map((n) => n.meta.cell_id);
    return [...leaves, ROOT_ID];
  }

  /** Branches that have been opened (their slot has an outcome). */
  openedBranches(): number[] {
    const out = new Set<number>();
    for (const n of this.cells.values()) if (isOpened(n)) out.add(n.meta.branch);
    return [...out].sort((a, b) => a - b);
  }

  /** Root slots that have not been opened yet, in branch order. */
  unopenedRoots(): string[] {
    return [...this.cells.values()]
      .filter((n) => n.meta.parent_id === ROOT_ID && !isOpened(n))
      .sort((a, b) => a.meta.branch - b.meta.branch)
      .map((n) => n.meta.cell_id);
  }

  /** Deepest revealed cell of a branch (the branch frontier), or null. */
  frontierOf(branch: number): TreeNode | null {
    const chain = this.branchChain(branch);
    return chain.length > 0 ? chain[chain.length - 1] : null;
  }

  branchChain(branch: number): TreeNode[] {
    return this.list().filter((n) => n.meta.branch === branch);
  }

  /**
   * Legal action set: unopened roots + one frontier per opened branch (paper Appendix B).
   * Frontiers at the grid's refinement limit are not selectable: the grid is `branch x attempt`.
   */
  legalActions(): string[] {
    const actions = this.unopenedRoots();
    const seen = new Set<number>();
    // Newest frontier first: prefer progress on branches already investigated.
    for (const node of [...this.list()].reverse()) {
      if (seen.has(node.meta.branch)) continue;
      if (!isOpened(node)) continue;
      const frontier = this.frontierOf(node.meta.branch);
      if (!frontier) continue;
      seen.add(node.meta.branch);
      if (this.refineCount > 0 && frontier.meta.attempt + 1 >= this.refineCount) continue;
      actions.push(frontier.meta.cell_id);
    }
    return actions;
  }

  /**
   * Observation for a revealed cell. `n_valid` / `n_total` count the branch trajectory revealed so
   * far (a branch with zero valid attempts is evidence, not an automatic closure).
   */
  observation(cell: string): Observation {
    const node = this.get(cell);
    if (!node) throw new Error(`unknown cell: ${cell}`);
    const parent = node.meta.parent_id ? this.get(node.meta.parent_id) : undefined;
    const chain = node.meta.branch >= 0 ? this.branchChain(node.meta.branch).filter((n) => n.meta.seq <= node.meta.seq) : [node];
    const evaluated = chain.filter((n) => n.evaluated);
    const baseline = this.baselineScore;
    const delta = (ref: number | null | undefined): number | null =>
      typeof ref === "number" && typeof node.score === "number" ? Number((node.score - ref).toFixed(10)) : null;
    const parentScore = parent && typeof parent.score === "number" ? parent.score : baseline;
    return {
      branch: node.meta.branch,
      attempt: node.meta.attempt,
      score: node.score,
      evaluated: node.evaluated,
      valid: node.valid,
      fail_class: node.fail_class,
      error: node.error,
      delta_vs_baseline: delta(baseline),
      delta_vs_parent: delta(parentScore),
      n_valid: evaluated.filter((n) => n.valid).length,
      n_total: evaluated.length,
    };
  }

  /** Best score over successful evaluations across the revealed tree (root included). */
  bestScore(): number | null {
    let best = this.root.error === null && this.root.fail_class === "ok" ? this.root.score : null;
    for (const node of this.cells.values()) {
      if (!isSuccess(node) || typeof node.score !== "number") continue;
      if (best === null || node.score > best) best = node.score;
    }
    return best;
  }

  toJSON(): TreeJSON {
    return {
      version: 1,
      branch_count: this.branchCount,
      refine_count: this.refineCount,
      seq: this.seq,
      baseline_score: this.root.score,
      cells: this.list(),
    };
  }

  static fromJSON(json: TreeJSON): DiscoveryTree {
    const tree = new DiscoveryTree({
      baselineScore: json.baseline_score ?? null,
      branchCount: json.branch_count ?? 0,
      refineCount: json.refine_count ?? 0,
    });
    tree.seq = json.seq ?? 1;
    for (const node of json.cells ?? []) {
      if (!node?.meta?.cell_id || node.meta.cell_id === ROOT_ID) continue;
      tree.cells.set(node.meta.cell_id, { ...node, meta: { ...node.meta, tags: node.meta.tags ?? [] } });
      tree.seq = Math.max(tree.seq, node.meta.seq + 1);
    }
    return tree;
  }
}
