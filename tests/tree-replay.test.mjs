/**
 * Discovery-tree and replay-transition contracts (paper §3).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DiscoveryTree, ROOT_ID, cellId, isOpened, isSuccess } from "../extensions/pi-dream-rsi/engine/tree.ts";
import { makeReplayProbe } from "../extensions/pi-dream-rsi/engine/replay.ts";
import { PolicyHost } from "../extensions/pi-dream-rsi/policy/host.ts";

/** A live-shaped probe: an unrevealed slot reveals itself, an opened frontier reveals its child. */
function liveProbe(value = () => 1) {
  const seen = new Set();
  return async (cells) =>
    cells.map((cell) => {
      if (!seen.has(cell)) {
        seen.add(cell);
        return { cell, node: { evaluated: true, fail_class: "ok", error: null, score: value(cell) } };
      }
      const parsed = /^b(\d+)a(\d+)$/.exec(cell);
      const child = cellId(Number(parsed[1]), Number(parsed[2]) + 1);
      seen.add(child);
      return { cell: child, node: { evaluated: true, fail_class: "ok", error: null, score: value(child) } };
    });
}

function treeWith({ baseline = null, branches = 2, refine = 3 } = {}) {
  const tree = new DiscoveryTree({ baselineScore: baseline, branchCount: branches, refineCount: refine });
  for (let branch = 0; branch < branches; branch += 1) tree.addBranchSlot(branch);
  return tree;
}

function score(tree, cell, value, extra = {}) {
  return tree.setOutcome(cell, { evaluated: true, fail_class: "ok", error: null, score: value, ...extra });
}

test("A(T) = root + leaves; opened branches expose exactly one frontier each", () => {
  const tree = treeWith();
  assert.deepEqual(tree.unopenedRoots(), ["b0a0", "b1a0"]);
  assert.deepEqual(tree.eligible(), ["b0a0", "b1a0", ROOT_ID]);
  assert.deepEqual(tree.legalActions(), ["b0a0", "b1a0"]);

  score(tree, "b0a0", 1);
  assert.deepEqual(tree.openedBranches(), [0]);
  // The branch root is itself the frontier until it gains a child.
  assert.deepEqual(tree.legalActions(), ["b1a0", "b0a0"]);

  const child = tree.addChild("b0a0", 0, 1);
  assert.equal(child.meta.parent_id, "b0a0");
  assert.deepEqual(tree.leaves().map((n) => n.meta.cell_id).sort(), ["b0a1", "b1a0"]);
  assert.deepEqual(tree.legalActions(), ["b1a0", "b0a1"]);
});

test("grid limits: a frontier at the refinement cap is no longer selectable", () => {
  const tree = treeWith({ refine: 2 });
  score(tree, "b0a0", 1);
  assert.deepEqual(tree.legalActions().filter((c) => c.startsWith("b0")), ["b0a0"]);
  tree.addChild("b0a0", 0, 1);
  score(tree, "b0a1", 2);
  assert.deepEqual(tree.legalActions().filter((c) => c.startsWith("b0")), [], "attempt 1 is the grid's last row");
});

test("replay opens branches in creation order, not in the order the policy names them", async () => {
  const world = new DiscoveryTree({ branchCount: 2, refineCount: 2 });
  world.addBranchSlot(1); // created first
  world.addBranchSlot(0); // created second
  score(world, "b1a0", 5);
  score(world, "b0a0", 1);
  assert.deepEqual(world.list().map((n) => n.meta.cell_id), ["b1a0", "b0a0"]);

  const revealed = new Set();
  const probe = makeReplayProbe(world, (cell) => revealed.has(cell));
  const first = await probe(["b0a0"], 1); // names branch 0, must reveal the earliest-created branch
  assert.deepEqual(first.map((r) => r.cell), ["b1a0"]);
  revealed.add("b1a0");
  const second = await probe(["b0a0"], 2);
  assert.deepEqual(second.map((r) => r.cell), ["b0a0"], "next earliest unobserved branch");
  assert.equal(second[0].node.meta.seq > first[0].node.meta.seq, true);
});

test("probing an opened frontier reveals its unique recorded child, and nothing when the chain ends", async () => {
  const world = treeWith({ branches: 1, refine: 3 });
  score(world, "b0a0", 1);
  const child = world.addChild("b0a0", 0, 1);
  score(world, child.meta.cell_id, 2);
  const revealed = new Set();
  const probe = makeReplayProbe(world, (cell) => revealed.has(cell));

  const opened = await probe(["b0a0"], 1); // unrevealed slot: reveals the branch root itself
  assert.deepEqual(opened.map((r) => r.cell), ["b0a0"]);
  revealed.add("b0a0");
  const refined = await probe(["b0a0"], 2); // opened frontier: reveals its recorded child
  assert.deepEqual(refined.map((r) => r.cell), [child.meta.cell_id]);
  revealed.add(child.meta.cell_id);
  assert.deepEqual(await probe([child.meta.cell_id], 3), [], "no recorded continuation => Child(v) = empty");
});

test("observation semantics: deltas, branch counts, and success == evaluated & no error & fail_class ok", () => {
  const tree = treeWith({ baseline: 10, branches: 1, refine: 3 });
  score(tree, "b0a0", 12);
  const child = tree.addChild("b0a0", 0, 1);
  score(tree, "b0a1", 15);
  const third = tree.addChild("b0a1", 0, 2);
  tree.setOutcome("b0a2", { evaluated: true, fail_class: "eval_error", error: "boom", score: null });

  const root = tree.observation("b0a0");
  assert.equal(root.delta_vs_baseline, 2);
  assert.equal(root.delta_vs_parent, 2, "a branch root is compared against the baseline");
  assert.equal(root.n_total, 1);

  const middle = tree.observation(child.meta.cell_id);
  assert.equal(middle.delta_vs_parent, 3);
  assert.equal(middle.n_valid, 2);
  assert.equal(middle.n_total, 2);

  const failed = tree.observation(third.meta.cell_id);
  assert.equal(failed.score, null);
  assert.equal(failed.valid, false);
  assert.equal(failed.fail_class, "eval_error");
  assert.equal(failed.n_total, 3);
  assert.equal(failed.n_valid, 2, "a repairable zero-valid failure is visible, not hidden");
  assert.equal(isSuccess(tree.get("b0a2")), false);

  // A successful evaluation with the evaluator's validity flag off still counts (paper Appendix B).
  const risky = tree.addChild("b0a2", 0, 3);
  tree.setOutcome(risky.meta.cell_id, { evaluated: true, fail_class: "ok", error: null, score: 99, valid: false });
  assert.equal(isSuccess(tree.get(risky.meta.cell_id)), true);
  assert.equal(tree.observation(risky.meta.cell_id).valid, false);
  assert.equal(tree.bestScore(), 99);
});

test("PolicyHost rejects illegal batches instead of silently coercing them", async () => {
  const host = new PolicyHost({
    mode: "live",
    maxParallelism: 2,
    grid: { branch_count: 2, refine_count: 2 },
    probe: liveProbe(),
  });
  await assert.rejects(() => host.probe_batch([]), /empty batch/);
  await assert.rejects(() => host.probe_batch(["b0a0", "b0a0"]), /duplicate/);
  await assert.rejects(() => host.probe_batch(["b0a0", "b1a0", "b9a9"]), /exceeds max_parallelism/);
  await assert.rejects(() => host.probe_batch(["b9a9"]), /illegal cell id/);
  await assert.rejects(() => host.probe_batch([ROOT_ID]), /not itself an action/);

  // Legal batch, and a parent+child pair never becomes selectable together.
  await host.probe_batch(["b0a0"]);
  await assert.rejects(() => host.probe_batch(["b0a0", "b0a1"]), /illegal cell id/);
  await host.probe_batch(["b0a0"]);
  assert.deepEqual(Object.keys(host.observed()).sort(), ["b0a0", "b0a1"]);
});

test("PolicyHost hides unrevealed cells: observed() is the prefix and nothing else", async () => {
  const world = treeWith({ branches: 2, refine: 3 });
  score(world, "b0a0", 1);
  const child = world.addChild("b0a0", 0, 1);
  score(world, child.meta.cell_id, 7);

  const revealed = new Set();
  const probe = makeReplayProbe(world, (cell) => revealed.has(cell));
  const host = new PolicyHost({
    mode: "replay",
    maxParallelism: 2,
    baselineScore: null,
    refineCount: 3,
    slots: [0, 1],
    probe: async (cells, round) => {
      const records = await probe(cells, round);
      for (const record of records) revealed.add(record.cell);
      return records;
    },
  });
  assert.deepEqual(host.observed(), {}, "nothing is known before the first probe");
  assert.deepEqual(host.legal_roots(), ["b0a0", "b1a0"]);
  await host.probe_batch(["b0a0"]);
  assert.deepEqual(Object.keys(host.observed()), ["b0a0"]);
  assert.equal(host.best_so_far, 1);
  await host.probe_batch(["b0a0"]);
  assert.deepEqual(Object.keys(host.observed()).sort(), ["b0a0", "b0a1"]);
  assert.equal(host.budget_spent, 2);
});

test("the environment enforces the round limit (K1/K2), so a policy cannot outrun it", async () => {
  const host = new PolicyHost({
    mode: "replay",
    maxParallelism: 1,
    maxRounds: 2,
    slots: [0],
    probe: liveProbe(),
  });
  await host.probe_batch(["b0a0"]);
  await host.probe_batch(["b0a0"]);
  assert.deepEqual(host.legal_actions(), [], "no legal action after K2 rounds");
  await assert.rejects(() => host.probe_batch(["b0a0"]), /round limit reached/);
});
