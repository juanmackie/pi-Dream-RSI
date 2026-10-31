import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { appendLesson, lessonProfile, readLessons, replayLessonPrefix } from "../extensions/pi-dream-rsi/engine/lessons.ts";
import { emptyMemory, ucbSelect } from "../extensions/pi-dream-rsi/engine/search.ts";

const record = (leverId, outcome, extra = {}) => ({
  kind: "campaign", leverId, outcome, evaluatorRuns: 2, agentStarts: 1, wallMs: 100,
  at: "2026-10-16T00:00:00.000Z", ...extra,
});
function tempRoot(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, root: path.join(dir, ".dream-rsi", "memory") };
}

function evidence(root, campaignId) {
  const ledgerFile = path.join(path.dirname(root), "campaigns", campaignId, "history", "ledger.jsonl");
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify({ v: 1, t: "2026-10-16T00:00:00.000Z", entryId: `entry-${campaignId}`, kind: "attempt", campaignId, outcome: "complete" })}\n`);
  fs.writeFileSync(ledgerFile, bytes);
  return { campaignId, ledgerHash: createHash("sha256").update(bytes).digest("hex"), ledgerEntries: 1 };
}

function profile(overrides = {}) {
  return lessonProfile({
    benchmark: "benchmark-1", executor: { command: "pi-bolt", model: "fixture" },
    mode: "legacy", budget: { campaigns: 6, agents: 400 }, seed: null, ...overrides,
  });
}

test("lessons are durable, evidence-linked, library-scoped and replay strictly before a causal prefix", () => {
  const { dir, root } = tempRoot("dream-rsi-lessons-");
  try {
    const scope = profile();
    const first = appendLesson(root, scope, record("alpha", "win", { verifiedGain: 20,
      provenance: { contractId: "a".repeat(16), baselineFingerprint: "b".repeat(64), mechanism: "cache lookup", strategyClass: "slow-command" } }), evidence(root, "campaign-1"));
    const second = appendLesson(root, scope, record("beta", "no-win", {
      provenance: { contractId: "a".repeat(16), baselineFingerprint: "c".repeat(64), mechanism: "retry reduction" },
    }), evidence(root, "campaign-2"));
    const third = appendLesson(root, scope, record("alpha", "no-win", {
      provenance: { contractId: "a".repeat(16), baselineFingerprint: "d".repeat(64) },
    }), evidence(root, "campaign-3"));

    assert.deepEqual([first.sequence, second.sequence, third.sequence], [1, 2, 3]);
    const entries = readLessons(root, scope);
    assert.equal(entries.length, 3);
    const ledgerBytes = fs.readFileSync(path.join(path.dirname(root), "campaigns", "campaign-1", "history", "ledger.jsonl"));
    assert.equal(entries[0].evidence.ledgerHash, createHash("sha256").update(ledgerBytes).digest("hex"));
    assert.equal(entries[0].record.leverId, "alpha");
    assert.equal(entries[0].record.provenance.mechanism, "cache lookup", "the persisted lesson keeps its causal mechanism");

    const beforeSecond = replayLessonPrefix(entries, 2);
    assert.equal(beforeSecond.leverStats.alpha.campaigns, 1);
    assert.equal(beforeSecond.leverStats.beta, undefined, "sequence 2 is excluded, not peeked at");

    const levers = [{ id: "alpha", score: 1 }, { id: "beta", score: 0.5 }];
    const ranking1 = ucbSelect(levers, replayLessonPrefix(entries, 3), { strategy: "utility" });
    const ranking2 = ucbSelect(levers, replayLessonPrefix(readLessons(root, scope), 3), { strategy: "utility" });
    assert.deepEqual(ranking1, ranking2, "the same persisted evidence prefix reproduces the same ranking");
    assert.equal(ranking1.selected.id, "alpha");
    assert.equal(replayLessonPrefix(entries, 4).leverStats.alpha.campaigns, 2);
    const currentBaseline = replayLessonPrefix(entries, Number.POSITIVE_INFINITY, { baselineFingerprint: "c".repeat(64) });
    assert.equal(currentBaseline.leverStats.alpha, undefined, "a lesson from a prior applied baseline cannot steer the new baseline");
    assert.equal(currentBaseline.leverStats.beta.campaigns, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("lessons do not cross benchmark, executor, mode, budget or seed libraries", () => {
  const { dir, root } = tempRoot("dream-rsi-lesson-scope-");
  try {
    const baseline = profile();
    appendLesson(root, baseline, record("alpha", "win", { verifiedGain: 12 }), evidence(root, "campaign-1"));
    const variants = [
      profile({ benchmark: "benchmark-2" }),
      profile({ executor: { command: "other" } }),
      profile({ mode: "rsi" }),
      profile({ budget: { campaigns: 2, agents: 10 } }),
      profile({ seed: "seed-2" }),
    ];
    for (const variant of variants) {
      assert.equal(readLessons(root, variant).length, 0);
      assert.deepEqual(replayLessonPrefix(readLessons(root, variant), 1), emptyMemory());
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("lesson store rejects corrupt history and duplicate campaigns instead of forking evidence", () => {
  const { dir, root } = tempRoot("dream-rsi-lesson-corrupt-");
  try {
    const scope = profile();
    const original = record("alpha", "no-win");
    const linked = evidence(root, "campaign-1");
    const first = appendLesson(root, scope, original, linked);
    assert.equal(appendLesson(root, scope, original, linked).recordHash, first.recordHash, "an exact retry is idempotent");
    assert.throws(() => appendLesson(root, scope, { ...original, wallMs: 101 }, linked), /already exists/, "a changed retry cannot silently rewrite campaign evidence");
    assert.throws(() => appendLesson(root, scope, record("beta", "win"), linked), /already exists/);
    const ledgerFile = path.join(path.dirname(root), "campaigns", "campaign-1", "history", "ledger.jsonl");
    const intactLedger = fs.readFileSync(ledgerFile);
    fs.writeFileSync(ledgerFile, `${JSON.stringify({ v: 1, t: "2026-10-16T00:00:00.000Z", entryId: "changed", kind: "attempt", campaignId: "campaign-1", outcome: "changed" })}\n`);
    assert.throws(() => readLessons(root, scope), /corrupted lesson history/, "a stale digest cannot steer allocation after its ledger changes");
    fs.writeFileSync(ledgerFile, intactLedger);
    const file = path.join(root, `${scope.id}.jsonl`);
    fs.appendFileSync(file, "{broken\n");
    assert.throws(() => readLessons(root, scope), /corrupted lesson history/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
