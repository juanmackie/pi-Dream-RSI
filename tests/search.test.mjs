import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  attemptsFromMemory, emptyMemory, isCurrentExperiment, mementoNotes, readMemory,
  recordCampaignOutcome, ucbSelect, writeMemory,
} from "../extensions/pi-dream-rsi/engine/search.ts";

const AT = "2026-10-16T00:00:00.000Z";

function record(leverId, outcome, extra = {}) {
  return { kind: "campaign", leverId, outcome, evaluatorRuns: 1, agentStarts: 2, wallMs: 100, at: AT, ...extra };
}

function stats(spec) {
  return { campaigns: 3, wins: 0, evaluatorRuns: 30, agentStarts: 6, wallMs: 3000, lastOutcome: "no-win", lastAt: AT, ...spec };
}

test("ucbSelect explores untried levers first by score, then trades win rate against the exploration bonus", () => {
  const levers = [{ id: "alpha", score: 0.5 }, { id: "beta", score: 0.9 }];
  const fresh = ucbSelect(levers, emptyMemory());
  assert.equal(fresh.selected.id, "beta", "among untried levers the inventory score decides");
  assert.ok(fresh.ranking.every((entry) => entry.reason.includes("untried")));

  const betaTried = { ...emptyMemory(), leverStats: { beta: stats({ wins: 1, lastOutcome: "win" }) } };
  assert.equal(ucbSelect(levers, betaTried).selected.id, "alpha", "untried levers are opened before revisiting a proven one");

  const bothTried = { ...emptyMemory(), leverStats: { alpha: stats({}), beta: stats({ wins: 1, lastOutcome: "win" }) } };
  const exploited = ucbSelect(levers, bothTried);
  assert.equal(exploited.selected.id, "beta", "with equal counts the higher win rate wins");

  const explored = ucbSelect(levers, { ...emptyMemory(), leverStats: { alpha: stats({ campaigns: 12 }), beta: stats({ wins: 1, lastOutcome: "win" }) } });
  assert.equal(explored.selected.id, "beta", "one win over one campaign still beats zero wins over twelve");
  const alphaEntry = explored.ranking.find((entry) => entry.id === "alpha");
  assert.ok(alphaEntry.ucb > 0, "a tried lever always carries a nonzero exploration bonus");

  const again = ucbSelect(levers, bothTried);
  assert.deepEqual(again, exploited, "allocation is deterministic for identical memory");
});

test("recordCampaignOutcome aggregates stats, keeps the latest outcome per lever, and bounds notes", () => {
  let memory = emptyMemory();
  memory = recordCampaignOutcome(memory, record("alpha", "no-win"));
  memory = recordCampaignOutcome(memory, record("beta", "win", { evaluatorRuns: 9 }));
  memory = recordCampaignOutcome(memory, record("alpha", "rejected", { evaluatorRuns: 0, agentStarts: 0 }));

  assert.equal(memory.leverStats.alpha.campaigns, 2);
  assert.equal(memory.leverStats.alpha.wins, 0);
  assert.equal(memory.leverStats.alpha.evaluatorRuns, 1, "zero-cost outcomes add nothing to spend");
  assert.equal(memory.leverStats.beta.wins, 1);
  assert.equal(memory.leverStats.beta.evaluatorRuns, 9);
  assert.equal(memory.outcomes.length, 3);

  const attempts = attemptsFromMemory(memory);
  assert.deepEqual(attempts, [
    { leverId: "alpha", outcome: "rejected" },
    { leverId: "beta", outcome: "win" },
  ], "only the latest outcome per lever feeds back into inventory ranking");

  const capped = { ...memory, notes: Array.from({ length: 80 }, (_, index) => `note-${index}`) };
  const after = recordCampaignOutcome(capped, record("gamma", "no-win"));
  assert.equal(after.notes.length, 50, "notes stay bounded across updates");

  const digest = mementoNotes(memory, 400);
  assert.ok(digest.length <= 400, "memento digest respects the character bound");
  assert.match(digest, /1 verified win/);
  assert.match(digest, /alpha: 2 campaign\(s\), 0 win\(s\)/);
});

test("memory persists atomically and corrupted state fails closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-search-"));
  try {
    const file = path.join(dir, "memory.json");
    assert.deepEqual(readMemory(file), emptyMemory(), "a missing file is an empty memory");
    const memory = recordCampaignOutcome(emptyMemory(), record("alpha", "win"));
    writeMemory(file, memory);
    assert.deepEqual(readMemory(file), memory, "round-trips exactly");

    fs.writeFileSync(file, "{ not json");
    assert.throws(() => readMemory(file), /corrupted state/);
    fs.writeFileSync(file, JSON.stringify({ version: 2, leverStats: {}, outcomes: [], notes: [] }));
    assert.throws(() => readMemory(file), /expected schema/);
    fs.writeFileSync(file, JSON.stringify({ version: 1, leverStats: {}, outcomes: [{ leverId: 7 }], notes: [] }));
    assert.throws(() => readMemory(file), /invalid outcome record/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("readMemory rejects impossible counters, unknown outcomes, and non-string notes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-search-schema-"));
  try {
    const file = path.join(dir, "memory.json");
    const valid = { version: 1, leverStats: { alpha: stats({}) }, outcomes: [record("alpha", "no-win")], notes: ["keep going"] };
    fs.writeFileSync(file, JSON.stringify(valid));
    assert.equal(readMemory(file).leverStats.alpha.wins, 0, "a conforming memory reads back");

    const cases = [
      { name: "negative counters", memory: { ...valid, leverStats: { alpha: stats({ campaigns: -1 }) } } },
      { name: "wins above campaigns", memory: { ...valid, leverStats: { alpha: stats({ campaigns: 1, wins: 2 }) } } },
      { name: "unknown outcome", memory: { ...valid, outcomes: [{ ...record("alpha", "no-win"), outcome: "maybe" }] } },
      { name: "object-valued note", memory: { ...valid, notes: [{ text: "not a string" }] } },
    ];
    for (const { name, memory } of cases) {
      fs.writeFileSync(file, JSON.stringify(memory));
      assert.throws(() => readMemory(file), /refusing to continue on corrupted state/, name);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("utility allocation ranks measured gain per confirmation run, and stale experiments are excluded", () => {
  const levers = [{ id: "big", score: 0.5 }, { id: "small", score: 0.9 }];
  const memory = {
    ...emptyMemory(),
    leverStats: {
      // Same win count, very different economics: `big` moved the objective far more per run.
      big: stats({ campaigns: 1, wins: 1, gain: 40, gainCostRuns: 20, lastOutcome: "win" }),
      small: stats({ campaigns: 1, wins: 1, gain: 1, gainCostRuns: 20, lastOutcome: "win" }),
    },
  };
  const winRate = ucbSelect(levers, memory, { strategy: "win-rate" });
  assert.equal(winRate.selected.id, "big", "equal win counts fall back to the id tie-break");

  const utility = ucbSelect(levers, memory, { strategy: "utility" });
  assert.equal(utility.selected.id, "big", "the lever with more measured gain per run wins");
  const entry = utility.ranking.find((row) => row.id === "big");
  assert.equal(entry.gainPerRun, 2, "gain per confirmation run is reported");
  assert.match(entry.reason, /verified gain 40\.000 over 20 confirmation run/);

  // A lever with no measured gain yet keeps its exploration bonus instead of being starved.
  const unexplored = { ...memory, leverStats: { big: memory.leverStats.big, small: stats({ campaigns: 1, wins: 0 }) } };
  const ranked = ucbSelect(levers, unexplored, { strategy: "utility" }).ranking;
  assert.ok(ranked.every((row) => Number.isFinite(row.ucb)), "every tried lever scores finitely");

  // Experiments from another objective or instrument are not comparable with these.
  const record = { kind: "campaign", leverId: "big", outcome: "win", evaluatorRuns: 1, agentStarts: 1, wallMs: 1, at: AT,
    provenance: { contractId: "other-contract" } };
  assert.equal(isCurrentExperiment(record, { contractId: "current" }), false);
  assert.equal(isCurrentExperiment(record, { contractId: "other-contract" }), true);
  assert.equal(isCurrentExperiment({ ...record, provenance: undefined }, { contractId: "current" }), true,
    "legacy records without provenance stay comparable");
  assert.equal(isCurrentExperiment({ ...record, provenance: { evaluatorId: "e1" } }, { evaluatorId: "e2" }), false);
});

test("a win only accrues measured gain when it carries a positive verified gain", () => {
  let memory = emptyMemory();
  memory = recordCampaignOutcome(memory, record("alpha", "win"));
  assert.equal(memory.leverStats.alpha.gain, 0, "a win without a measured gain contributes no utility");
  memory = recordCampaignOutcome(memory, record("alpha", "win", { verifiedGain: 12.5 }));
  assert.equal(memory.leverStats.alpha.gain, 12.5);
  assert.equal(memory.leverStats.alpha.gainCostRuns, 1);
  memory = recordCampaignOutcome(memory, record("alpha", "no-win", { verifiedGain: 99 }));
  assert.equal(memory.leverStats.alpha.gain, 12.5, "a non-win never accrues gain even if a number is present");
});
