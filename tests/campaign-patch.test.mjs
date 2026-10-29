import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { jump } from "./fixtures.mjs";

const { applyCandidatePatch, buildCandidatePatch, patchConflicts, readAppliedPatchPostimages, reconcileCandidatePatch, verifyCandidatePatch, workspaceDigest } = await jump("engine/campaign-patch.ts");

const HAS_GIT = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
function git(args, cwd) {
  const result = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

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

test("runner caches and build output are never candidate changes", async (t) => {
  const { seed, target, candidate } = await fixture(t);
  // A measurement run leaves these behind in the candidate workspace.
  const artifacts = {
    "app/__pycache__/main.cpython-313.pyc": "bytecode\n",
    ".pytest_cache/v/cache/lastfailed": "{}\n",
    "node_modules/.package-lock.json": "{}\n",
    "target/debug/build.txt": "build output\n",
  };
  for (const [relative, content] of Object.entries(artifacts)) {
    const file = path.join(candidate, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const patch = buildCandidatePatch({ cycleSeedRoot: seed, targetRoot: target, candidateRoot: candidate, scope: ["solution.txt", "helper.txt", "legacy.txt"], exclude: ["proposal.md", "eval/score.json"] });
  assert.deepEqual(patch.map(({ kind, relative }) => `${kind}:${relative}`), ["write:helper.txt", "delete:legacy.txt", "write:solution.txt"]);
});

test("a cache directory present in the seed stays candidate-visible when there is no git evidence", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-patch-committed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seed = path.join(root, "seed");
  const target = path.join(root, "target");
  const candidate = path.join(root, "candidate");
  for (const directory of [seed, target, candidate]) {
    fs.mkdirSync(path.join(directory, "target"), { recursive: true });
    fs.writeFileSync(path.join(directory, "target", "pinned.txt"), "v1\n");
    fs.writeFileSync(path.join(directory, "src.js"), "code\n");
  }
  fs.writeFileSync(path.join(candidate, "target", "pinned.txt"), "v2\n");
  fs.mkdirSync(path.join(candidate, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(candidate, "node_modules", "junk.js"), "junk\n");
  fs.mkdirSync(path.join(candidate, "build", "target"), { recursive: true });
  fs.writeFileSync(path.join(candidate, "build", "target", "fresh.txt"), "fresh\n");
  const patch = buildCandidatePatch({ cycleSeedRoot: seed, targetRoot: target, candidateRoot: candidate, scope: ["target/pinned.txt"] });
  assert.deepEqual(patch.map(({ kind, relative }) => `${kind}:${relative}`), ["write:target/pinned.txt"],
    "a cache path present in the seed is candidate-visible; caches the run created at other paths stay skipped");
});

test("git evidence separates tracked cache content from runner-created caches", { skip: HAS_GIT ? false : "git is not available on PATH" }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-patch-gitcache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "target", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "code\n");
  fs.writeFileSync(path.join(repo, "src", "target"), "file-shaped content\n");
  fs.writeFileSync(path.join(repo, "target", "pinned.txt"), "v1\n");
  fs.writeFileSync(path.join(repo, "target", "node_modules", "pinned.js"), "nested\n");
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "patch-test@example.invalid"], repo);
  git(["config", "user.name", "patch test"], repo);
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "fixture"], repo);
  // Runner activity after the commit leaves untracked caches in the live tree.
  fs.mkdirSync(path.join(repo, ".pytest_cache", "v", "cache"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".pytest_cache", "v", "cache", "lastfailed"), "{}\n");
  fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules", "pkg", "index.js"), "x\n");
  const copy = (from, to) => fs.cpSync(from, to, { recursive: true, filter: (source) => path.basename(source) !== ".git" });
  const seed = path.join(root, "seed");
  const candidate = path.join(root, "candidate");
  copy(repo, seed);
  copy(repo, candidate);
  fs.writeFileSync(path.join(candidate, "target", "pinned.txt"), "v2\n"); // an agent edit inside tracked cache content
  fs.writeFileSync(path.join(candidate, "target", "node_modules", "pinned.js"), "changed\n"); // nested cache path, also tracked
  fs.writeFileSync(path.join(candidate, "src", "target"), "changed\n"); // file-shaped cache name, also tracked
  fs.writeFileSync(path.join(candidate, ".pytest_cache", "v", "cache", "lastfailed"), "{}\nchurn\n"); // the runner rewrote its cache
  fs.writeFileSync(path.join(candidate, "node_modules", "pkg", "index.js"), "y\n"); // dependency churn
  const scope = ["target/pinned.txt", "target/node_modules/pinned.js", "src/target"];
  const patch = buildCandidatePatch({ cycleSeedRoot: seed, targetRoot: repo, candidateRoot: candidate, scope });
  assert.deepEqual(patch.map(({ kind, relative }) => `${kind}:${relative}`),
    ["write:src/target", "write:target/node_modules/pinned.js", "write:target/pinned.txt"],
    "tracked cache content is candidate-visible at any depth and shape; untracked runner caches stay skipped");
  const digestBase = workspaceDigest({ root: repo, cycleSeedRoot: seed, repoRoot: repo, exclude: [] });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "changed\n");
  assert.notEqual(workspaceDigest({ root: repo, cycleSeedRoot: seed, repoRoot: repo, exclude: [] }), digestBase, "a source edit changes the digest");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "code\n");
  fs.writeFileSync(path.join(repo, "target", "node_modules", "pinned.js"), "later\n");
  assert.notEqual(workspaceDigest({ root: repo, cycleSeedRoot: seed, repoRoot: repo, exclude: [] }), digestBase, "a nested tracked cache path participates in the digest");
  fs.writeFileSync(path.join(repo, "target", "node_modules", "pinned.js"), "nested\n");
  fs.writeFileSync(path.join(repo, "src", "target"), "later\n");
  assert.notEqual(workspaceDigest({ root: repo, cycleSeedRoot: seed, repoRoot: repo, exclude: [] }), digestBase, "a tracked file-shaped cache name participates in the digest");
  fs.writeFileSync(path.join(repo, "src", "target"), "file-shaped content\n");
  fs.writeFileSync(path.join(repo, ".pytest_cache", "v", "cache", "lastfailed"), "{}\nlater\n");
  assert.equal(workspaceDigest({ root: repo, cycleSeedRoot: seed, repoRoot: repo, exclude: [] }), digestBase, "untracked cache churn is invisible to the digest");
});

test("workspaceDigest follows candidate-visible content and ignores cache or excluded drift", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-digest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const anchor = path.join(root, "anchor"); // the cycle seed: no runner-created cache directories
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.mkdirSync(path.join(anchor, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "app.js"), "one\n");
  fs.writeFileSync(path.join(anchor, "src", "app.js"), "one\n");
  fs.mkdirSync(path.join(workspace, ".cache"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".cache", "state"), "1\n");
  const digest = () => workspaceDigest({ root: workspace, cycleSeedRoot: anchor });
  const base = digest();
  assert.equal(digest(), base, "the digest is deterministic");
  fs.writeFileSync(path.join(workspace, "src", "app.js"), "two\n");
  assert.notEqual(digest(), base, "a source edit changes the digest");
  fs.writeFileSync(path.join(workspace, "src", "app.js"), "one\n");
  assert.equal(digest(), base, "restoring the content restores the digest");
  fs.writeFileSync(path.join(workspace, ".cache", "state"), "2\n");
  assert.equal(digest(), base, "runner-created cache drift is invisible");
  fs.mkdirSync(path.join(workspace, "target"), { recursive: true });
  fs.mkdirSync(path.join(anchor, "target"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "target", "pinned.txt"), "v1\n");
  fs.writeFileSync(path.join(anchor, "target", "pinned.txt"), "v1\n");
  const withCommitted = digest();
  fs.writeFileSync(path.join(workspace, "target", "pinned.txt"), "v2\n");
  assert.notEqual(digest(), withCommitted, "a committed cache directory participates in the digest");
  const beforeProposal = digest();
  fs.writeFileSync(path.join(workspace, "proposal.md"), "note\n");
  assert.equal(workspaceDigest({ root: workspace, cycleSeedRoot: anchor, exclude: ["proposal.md"] }), beforeProposal,
    "excluded artifacts are invisible");
});

test("a real source edit outside the declared scope fails closed, and only that edit triggers it", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-patch-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seed = path.join(root, "seed");
  const target = path.join(root, "target");
  const candidate = path.join(root, "candidate");
  for (const directory of [seed, target, candidate]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "solution.txt"), "old\n");
  }
  fs.writeFileSync(path.join(candidate, "solution.txt"), "new\n");
  const options = { cycleSeedRoot: seed, targetRoot: target, candidateRoot: candidate, scope: ["solution.txt"] };
  assert.deepEqual(buildCandidatePatch(options).map(({ kind, relative }) => `${kind}:${relative}`), ["write:solution.txt"], "the edit itself is inside scope");

  fs.writeFileSync(path.join(candidate, "other.txt"), "sneaky\n");
  assert.throws(() => buildCandidatePatch(options), /outside declared scope: other\.txt/);

  fs.rmSync(path.join(candidate, "other.txt"));
  assert.deepEqual(buildCandidatePatch(options).map(({ kind, relative }) => `${kind}:${relative}`), ["write:solution.txt"], "the same call succeeds once other.txt is gone, so the throw was caused by it alone");
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

test("verified promotion postimages must match the ledger hash, changed-path list, and campaign target", async (t) => {
  const { root, seed, target, candidate } = await fixture(t);
  const patch = buildCandidatePatch({ cycleSeedRoot: seed, targetRoot: target, candidateRoot: candidate, exclude: ["proposal.md", "eval/score.json"] }).filter((op) => op.relative === "solution.txt");
  const journalDir = path.join(root, "journal");
  const transactionId = "verified-promotion";
  applyCandidatePatch({ seedRoot: target, patch, journalDir, transactionId });
  const journalPath = path.join(journalDir, `${transactionId}.json`);
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  const evidence = { transactionId, patchHash: journal.patchHash };
  const read = (expectedTargetRoot = target) => readAppliedPatchPostimages({ journalDir, transactions: [evidence], expectedTargetRoot });
  assert.deepEqual(read().changes, [{ path: "solution.txt", afterHash: patch[0].afterHash }]);
  assert.throws(() => read(path.join(root, "other-target")), /different campaign workspace/);

  journal.entries[0].afterHash = "a".repeat(64);
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  assert.throws(() => read(), /does not match its campaign ledger/);
  journal.entries[0].afterHash = patch[0].afterHash;
  journal.written = [];
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  assert.throws(() => read(), /changed-path list does not match/);
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

test("declared copy exclusions allow dependency links outside the candidate patch", async (t) => {
  const { root, seed, target, candidate } = await fixture(t);
  const outside = path.join(root, "dependencies");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "sentinel.txt"), "keep\n");
  try { fs.symlinkSync(outside, path.join(target, "node_modules"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (error.code === "EPERM" || error.code === "EACCES") return t.skip("symlink creation is unavailable"); throw error; }
  const patch = buildCandidatePatch({ cycleSeedRoot: seed, targetRoot: target, candidateRoot: candidate,
    exclude: ["node_modules", "proposal.md", "eval/score.json"] });
  assert.ok(patch.length > 0);
  assert.equal(patch.some((file) => file.relative.startsWith("node_modules")), false);
  assert.equal(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8"), "keep\n");
});
