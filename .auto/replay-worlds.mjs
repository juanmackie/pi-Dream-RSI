/**
 * Version 2 behavioral benchmark. Scores are frozen synthetic outcomes, not model output.
 * Keep this corpus and the replay engine outside the editable candidate workspace.
 */
import { DiscoveryTree, cellId } from "../extensions/pi-dream-rsi/engine/tree.ts";

export const BENCHMARK_VERSION = 2;
export const REPLAY_CONFIG = Object.freeze({
  maxParallelism: 2,
  k2: 4,
  beta1: 0.01,
  beta2: 0.01,
  lambda: 1,
});

// Equal weight and comparable score scales; no timings enter the objective.
const SPECS = [
  { id: "deep", branches: [[1, 5, 9], [2, 4, 6]] },
  { id: "breadth", branches: [[1, 1], [2, 2], [3, 7], [4, 9]] },
  { id: "recovery", branches: [[null, 3, 9], [2, 4, 6]] },
  { id: "plateau", branches: [[2, 2, 2], [2, 2, 2]] },
];

export function createReplayWorlds() {
  return SPECS.map(({ id, branches }) => {
    const world = new DiscoveryTree({
      baselineScore: 0,
      branchCount: branches.length,
      refineCount: Math.max(...branches.map((branch) => branch.length)),
    });
    // Materialize roots before children, matching live grid creation order.
    for (let branch = 0; branch < branches.length; branch += 1) world.addBranchSlot(branch);
    for (let branch = 0; branch < branches.length; branch += 1) {
      branches[branch].forEach((score, attempt) => {
        const cell = cellId(branch, attempt);
        if (attempt > 0) world.addChild(cellId(branch, attempt - 1), branch, attempt);
        world.setOutcome(cell, {
          evaluated: true,
          valid: score !== null,
          score,
          raw_score: score,
          fail_class: score === null ? "eval_error" : "ok",
          error: score === null ? "synthetic repairable failure" : null,
        });
      });
    }
    return { id, world };
  });
}
