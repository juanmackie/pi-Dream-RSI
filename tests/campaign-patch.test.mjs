import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { jump } from "./fixtures.mjs";

const { applyCandidatePatch, buildCandidatePatch, patchConflicts, reconcileCandidatePatch, verifyCandidatePatch } = await jump("engine/campaign-patch.ts");

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-patch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seed = path.join(root, "seed");
  const target = path.join(root, "target");
  const candidate = path.join(root, "candidate");
  for (const directory of [seed, target, candidate]) fs.mkdirSync(directory, { recursive: true });
  for (const directory of [seed, target, candidate]) {
    fs.writeFileSync(path.join(directory, "solution.txt"), "old\n");
    fs.writeFileSync(path.join(directory, "legacy.txt"), "remove me\n");
    fs.writeFileSync(path.join(directory, "score.mjs"), `
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
const source = readFileSync("solution.txt", "utf8").trim();
const improved = source === "new" && existsSync("helper.txt") && !existsSync("legacy.txt");
mkdirSync("eval", { recursive: true });
writeFileSync("eval/score.json", JSON.stringify({ score: improved ? 1 : 0, valid: true, fail_class: "ok", error: null }));
`);
  }
  fs.writeFileSync(path.join(candidate, "solution.txt"), "new\n");
  fs.writeFileSync(path.join(candidate, "helper.txt"), "needed\n");
  fs.rmSync(path.join(candidate, "legacy.txt"));
  fs.writeFileSync(path.join(candidate, "proposal.md"), "agent note\n");
  fs.mkdirSync(path.join(candidate, "eval"), { recursive: true });
  fs.writeFileSync(path.join(candidate, "eval", "score.json"), "{\"score\": 1}\n");
  return { root, seed, target, candidate };
}

test("builds a scoped full patch including additions, updates and removals", async (t) => {
  const { seed, target, candidate } = await fixture(t);
  const patch = buildCandidatePatch({ cycleSeedRoot: seed, targetRoot: target, candidateRoot: candidate, scope: ["solution.txt", "helper.txt", "legacy.txt"], exclude: ["proposal.md", "eval/score.json"] });
  assert.deepEqual(patch.map(({ kind, relative }) => `${kind}:${relative}`), ["write:helper.txt", "delete:legacy.txt", "write:solution.txt"]);
  assert.equal(patchConflicts({ cycleSeedRoot: seed, patch }).length, 0);
  assert.deepEqual(buildCandidatePatch({ cycleSeedRoot: seed, targetRoot: target, candidateRoot: candidate, exclude: ["proposal.md", "eval/score.json"] }).map((operation) => operation.relative), ["helper.txt", "legacy.txt", "solution.txt"]);
  assert.throws(() => buildCandidatePatch({ cycleSeedRoot: seed, targetRoot: target, candidateRoot: candidate, scope: ["solution.txt"] }), /outside declared scope/);
});

test("verifies a complete add-update-delete patch in scratch copies", async (t) => {
  const { root, seed, target, candidate } = await fixture(t);
  const patch = buildCandidatePatch({ cycleSeedRoot: seed, targetRoot: target, candidateRoot: candidate, exclude: ["proposal.md", "eval/score.json"] });
  const task = { workspace: ".", score_program: "node score.mjs", score_path: "eval/score.json", score_field: "score", valid_field: "valid", fail_class_field: "fail_class", error_field: "error", higher_is_better: true, evaluator_timeout_ms: 5000 };
  const verification = await verifyCandidatePatch({ dreamRoot: path.join(root, "dream"), projectDir: target, task, patch, evidenceDir: path.join(root, "evidence") });
  assert.equal(verification.before.score, 0);
  assert.equal(verification.after.score, 1);
  assert.equal(verification.improved, true);
  assert.equal(fs.readFileSync(path.join(target, "solution.txt"), "utf8"), "old\n");
  assert.equal(fs.existsSync(path.join(target, "legacy.txt")), true);
});

test("does not accept a higher score when the evaluator marks the candidate invalid", async (t) => {
  const { root, seed, target, candidate } = await fixture(t);
  const patch = buildCandidatePatch({ cycleSeedRoot: seed, targetRoot: target, candidateRoot: candidate, exclude: ["proposal.md", "eval/score.json"] });
  for (const directory of [target, candidate]) {
    fs.writeFileSync(path.join(directory, "score.mjs"), `
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
const improved = readFileSync("solution.txt", "utf8").trim() === "new";
mkdirSync("eval", { recursive: true });
writeFileSync("eval/score.json", JSON.stringify({ score: improved ? 999 : 1, valid: !improved, fail_class: "ok", error: null }));
`);
  }
  const task = { workspace: ".", score_program: "node score.mjs", score_path: "eval/score.json", score_field: "score", valid_field: "valid", fail_class_field: "fail_class", error_field: "error", higher_is_better: true, evaluator_timeout_ms: 5000 };
  const verification = await verifyCandidatePatch({ dreamRoot: path.join(root, "dream"), projectDir: target, task, patch, evidenceDir: path.join(root, "invalid-candidate") });
  assert.equal(verification.before.valid, true);
  assert.equal(verification.after.valid, false);
  assert.equal(verification.improved, false);
});

test("applies and reconciles a complete patch idempotently", async (t) => {
  const { root, seed, target, candidate } = await fixture(t);
  const patch = buildCandidatePatch({ cycleSeedRoot: seed, targetRoot: target, candidateRoot: candidate, exclude: ["proposal.md", "eval/score.json"] });
  const journalDir = path.join(root, "journal");
  const options = { seedRoot: target, patch, journalDir, transactionId: "cycle-1-candidate-a" };
  const receipt = applyCandidatePatch(options);
  assert.deepEqual(receipt.written, ["helper.txt", "legacy.txt", "solution.txt"]);
  assert.equal(fs.readFileSync(path.join(target, "solution.txt"), "utf8"), "new\n");
  assert.equal(fs.existsSync(path.join(target, "legacy.txt")), false);
  assert.equal(fs.readFileSync(path.join(target, "helper.txt"), "utf8"), "needed\n");
  assert.deepEqual(applyCandidatePatch(options), receipt);
});

test("reconciles a prepared write journal by restoring its preimage", async (t) => {
  const { root, seed, target, candidate } = await fixture(t);
  const patch = buildCandidatePatch({ cycleSeedRoot: seed, targetRoot: target, candidateRoot: candidate, exclude: ["proposal.md", "eval/score.json"] }).filter((op) => op.relative === "solution.txt");
  const journalDir = path.join(root, "journal");
  const transactionId = "interrupted-promotion";
  applyCandidatePatch({ seedRoot: target, patch, journalDir, transactionId });
  const journalPath = path.join(journalDir, `${transactionId}.json`);
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  journal.state = "prepared";
  fs.writeFileSync(journalPath, JSON.stringify(journal));

  assert.equal(reconcileCandidatePatch({ journalDir, transactionId }).state, "prepared");
  assert.equal(fs.readFileSync(path.join(target, "solution.txt"), "utf8"), "old\n");
  assert.equal(fs.existsSync(path.join(target, "helper.txt")), false);
  assert.equal(fs.readFileSync(path.join(target, "legacy.txt"), "utf8"), "remove me\n");
  assert.equal(reconcileCandidatePatch({ journalDir, transactionId }).state, "rolled_back");
});

test("retains backups and makes no partial rollback when a target was changed by a person", async (t) => {
  const { root, seed, target, candidate } = await fixture(t);
  const patch = buildCandidatePatch({ cycleSeedRoot: seed, targetRoot: target, candidateRoot: candidate, exclude: ["proposal.md", "eval/score.json"] }).filter((op) => op.relative !== "legacy.txt");
  const journalDir = path.join(root, "journal");
  const transactionId = "human-edited-after-interrupt";
  applyCandidatePatch({ seedRoot: target, patch, journalDir, transactionId });
  const journalPath = path.join(journalDir, `${transactionId}.json`);
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  journal.state = "prepared";
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  fs.writeFileSync(path.join(target, "solution.txt"), "human change\n");

  assert.throws(() => reconcileCandidatePatch({ journalDir, transactionId }), /cannot recover partial promotion/);
  assert.equal(fs.readFileSync(path.join(target, "solution.txt"), "utf8"), "human change\n");
  assert.equal(fs.readFileSync(path.join(target, "helper.txt"), "utf8"), "needed\n");
  assert.equal(fs.existsSync(journal.entries.find((entry) => entry.relative === "solution.txt").backup), true);
});

test("rejects stale target edits before changing any target file", async (t) => {
  const { root, seed, target, candidate } = await fixture(t);
  const patch = buildCandidatePatch({ cycleSeedRoot: seed, targetRoot: target, candidateRoot: candidate, exclude: ["proposal.md", "eval/score.json"] });
  fs.writeFileSync(path.join(target, "solution.txt"), "user edit\n");
  assert.deepEqual(patchConflicts({ cycleSeedRoot: seed, patch }), ["solution.txt"]);
  assert.throws(() => applyCandidatePatch({ seedRoot: target, patch, journalDir: path.join(root, "journal"), transactionId: "stale" }), /target changed/);
  assert.equal(fs.readFileSync(path.join(target, "solution.txt"), "utf8"), "user edit\n");
  assert.equal(fs.existsSync(path.join(target, "helper.txt")), false);
});

test("rejects symlink entries rather than following them into another tree", async (t) => {
  const { root, seed, target, candidate } = await fixture(t);
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "sentinel.txt"), "keep\n");
  try { fs.symlinkSync(outside, path.join(candidate, "linked"), "junction"); }
  catch (error) { if (error.code === "EPERM" || error.code === "EACCES") return t.skip("symlink creation is unavailable on this host"); throw error; }
  assert.throws(() => buildCandidatePatch({ cycleSeedRoot: seed, targetRoot: target, candidateRoot: candidate }), /symbolic links are not supported/);
  assert.equal(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8"), "keep\n");
});
