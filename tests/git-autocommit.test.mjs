import assert from "node:assert/strict";
import { test } from "node:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import fsDefault from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const { ensureAutoCommitBranch, commitVerifiedChanges } = await import("../extensions/pi-dream-rsi/engine/git.ts");

function makeGitProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-git-"));
  execFileSync("git", ["init", "--initial-branch", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Dream RSI Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "dream-rsi-test@example.invalid"], { cwd: root });
  fs.writeFileSync(path.join(root, "solution.txt"), "baseline\n");
  execFileSync("git", ["add", "solution.txt"], { cwd: root });
  execFileSync("git", ["commit", "-m", "baseline"], { cwd: root, stdio: "ignore" });
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function hash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

test("auto-commit rejects a configured default branch from any remote", async (t) => {
  const project = makeGitProject(); t.after(project.cleanup);
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-upstream-"));
  t.after(() => fs.rmSync(remote, { recursive: true, force: true }));
  execFileSync("git", ["init", "--bare", "--initial-branch=stable", remote], { stdio: "ignore" });
  execFileSync("git", ["remote", "add", "upstream", remote], { cwd: project.root });
  execFileSync("git", ["push", "upstream", "main:stable"], { cwd: project.root, stdio: "ignore" });
  execFileSync("git", ["fetch", "upstream"], { cwd: project.root, stdio: "ignore" });
  execFileSync("git", ["remote", "set-head", "upstream", "stable"], { cwd: project.root });
  await assert.rejects(ensureAutoCommitBranch(project.root, "stable"), /configured default branch/i);
});

test("auto-commit preparation selects only a clean, non-default feature branch", async (t) => {
  const project = makeGitProject(); t.after(project.cleanup);
  const result = await ensureAutoCommitBranch(project.root, "dream-rsi/improve");
  assert.equal(result.branch, "dream-rsi/improve");
  assert.match(execFileSync("git", ["branch", "--show-current"], { cwd: project.root, encoding: "utf8" }).trim(), /^dream-rsi\/improve$/);
  await assert.rejects(ensureAutoCommitBranch(project.root, "main"), /default branch/i);
  fs.writeFileSync(path.join(project.root, "user.txt"), "uncommitted\n");
  await assert.rejects(ensureAutoCommitBranch(project.root, "dream-rsi/improve"), /clean working tree/i);
  const resumed = await ensureAutoCommitBranch(project.root, "dream-rsi/improve", undefined, true);
  assert.equal(resumed.branch, "dream-rsi/improve", "explicit recovery on the same branch preserves dirty worktree state for verification");
});

test("auto-commit commits only verified postimages with structured evidence", async (t) => {
  const project = makeGitProject(); t.after(project.cleanup);
  const { branch, head } = await ensureAutoCommitBranch(project.root, "dream-rsi/improve");
  const content = "verified improvement\n";
  fs.writeFileSync(path.join(project.root, "solution.txt"), content);
  const commit = await commitVerifiedChanges({
    projectDir: project.root, branch, expectedHead: head,
    changes: [{ path: "solution.txt", afterHash: hash(content) }],
    campaignId: "campaign-123", leverId: "lever-abc", unit: "ms", before: 100, after: 80,
    evidencePath: ".dream-rsi/campaigns/campaign-123",
  });
  assert.match(commit.hash, /^[a-f0-9]{40,64}$/);
  assert.equal(commit.branch, "dream-rsi/improve");
  assert.equal(execFileSync("git", ["show", "-s", "--format=%s", commit.hash], { cwd: project.root, encoding: "utf8" }).trim(), "Dream-RSI: verified improvement (campaign-123)");
  assert.match(execFileSync("git", ["show", "-s", "--format=%B", commit.hash], { cwd: project.root, encoding: "utf8" }), /Metric: 100 -> 80 ms[\s\S]*Lever: lever-abc[\s\S]*Evidence: \.dream-rsi\/campaigns\/campaign-123/);
  assert.deepEqual(execFileSync("git", ["diff", "--name-only", "HEAD^", "HEAD"], { cwd: project.root, encoding: "utf8" }).trim().split(/\r?\n/), ["solution.txt"]);
  const recovered = await commitVerifiedChanges({
    projectDir: project.root, branch, expectedHead: commit.hash,
    changes: [{ path: "solution.txt", afterHash: hash(content) }],
    campaignId: "campaign-123", leverId: "lever-abc", unit: "ms", before: 100, after: 80,
    evidencePath: ".dream-rsi/campaigns/campaign-123",
  });
  assert.deepEqual(recovered, commit, "a resumed verified campaign recognizes its already-created commit");
});

test("auto-commit preserves verified delete-plus-add renames as two explicit paths", async (t) => {
  const project = makeGitProject(); t.after(project.cleanup);
  const { branch, head } = await ensureAutoCommitBranch(project.root, "dream-rsi/improve");
  const content = fs.readFileSync(path.join(project.root, "solution.txt"));
  fs.renameSync(path.join(project.root, "solution.txt"), path.join(project.root, "renamed.txt"));
  const commit = await commitVerifiedChanges({
    projectDir: project.root, branch, expectedHead: head,
    changes: [
      { path: "solution.txt", afterHash: null },
      { path: "renamed.txt", afterHash: hash(content) },
    ],
    campaignId: "campaign-rename", leverId: "lever-abc", unit: "ms", before: 100, after: 80,
    evidencePath: ".dream-rsi/campaigns/campaign-rename",
  });
  assert.deepEqual(commit.files, ["renamed.txt", "solution.txt"]);
  assert.deepEqual(execFileSync("git", ["diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-r", "-z", commit.hash], { cwd: project.root, encoding: "utf8" }).split("\0").filter(Boolean), commit.files);
});

test("an abort during the atomic Git commit finishes validation and returns its receipt", async (t) => {
  const project = makeGitProject(); t.after(project.cleanup);
  const { branch, head } = await ensureAutoCommitBranch(project.root, "dream-rsi/improve");
  const content = "verified improvement\n";
  fs.writeFileSync(path.join(project.root, "solution.txt"), content);
  const internalState = path.join(project.root, ".dream-rsi", "loop");
  fs.mkdirSync(internalState, { recursive: true });
  const marker = path.join(internalState, "hook-started");
  const shellPath = process.platform === "win32"
    ? `/${project.root[0].toLowerCase()}${project.root.slice(2).replaceAll("\\", "/")}/.dream-rsi/loop/hook-started`
    : marker;
  fs.mkdirSync(path.join(project.root, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(project.root, ".git", "hooks", "pre-commit"), `#!/bin/sh\nprintf x > '${shellPath}'\nsleep 1\n`);
  const controller = new AbortController();
  const watcher = setInterval(() => { if (fs.existsSync(marker)) controller.abort(); }, 10);
  let receipt;
  try {
    receipt = await commitVerifiedChanges({
      projectDir: project.root, branch, expectedHead: head,
      changes: [{ path: "solution.txt", afterHash: hash(content) }],
      campaignId: "campaign-abort", leverId: "lever-abc", unit: "ms", before: 100, after: 80,
      evidencePath: ".dream-rsi/campaigns/campaign-abort", signal: controller.signal,
    });
  } finally { clearInterval(watcher); }
  assert.equal(controller.signal.aborted, true, "the hook cancellation happened during commit");
  assert.notEqual(receipt.hash, head);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: project.root, encoding: "utf8" }).trim(), receipt.hash);
});

test("a Git hook cannot redirect a verified commit onto main", async (t) => {
  const project = makeGitProject(); t.after(project.cleanup);
  const { branch, head } = await ensureAutoCommitBranch(project.root, "dream-rsi/improve");
  fs.mkdirSync(path.join(project.root, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(project.root, ".git", "hooks", "pre-commit"), "#!/bin/sh\ngit symbolic-ref HEAD refs/heads/main\n");
  const content = "verified improvement\n";
  fs.writeFileSync(path.join(project.root, "solution.txt"), content);
  await assert.rejects(commitVerifiedChanges({
    projectDir: project.root, branch, expectedHead: head,
    changes: [{ path: "solution.txt", afterHash: hash(content) }],
    campaignId: "campaign-redirect", leverId: "lever-abc", unit: "ms", before: 100, after: 80,
    evidencePath: ".dream-rsi/campaigns/campaign-redirect",
  }), /branch references were rolled back/i);
  assert.equal(execFileSync("git", ["rev-parse", "main"], { cwd: project.root, encoding: "utf8" }).trim(), head);
  assert.equal(execFileSync("git", ["rev-parse", "dream-rsi/improve"], { cwd: project.root, encoding: "utf8" }).trim(), head);
});

test("auto-commit validates Git-normalized CRLF postimages", async (t) => {
  const project = makeGitProject(); t.after(project.cleanup);
  execFileSync("git", ["config", "core.autocrlf", "true"], { cwd: project.root });
  const { branch, head } = await ensureAutoCommitBranch(project.root, "dream-rsi/improve");
  const content = "verified improvement\r\n";
  fs.writeFileSync(path.join(project.root, "solution.txt"), content);
  const commit = await commitVerifiedChanges({
    projectDir: project.root, branch, expectedHead: head,
    changes: [{ path: "solution.txt", afterHash: hash(content) }],
    campaignId: "campaign-crlf", leverId: "lever-abc", unit: "ms", before: 100, after: 80,
    evidencePath: ".dream-rsi/campaigns/campaign-crlf",
  });
  assert.equal(execFileSync("git", ["show", `${commit.hash}:solution.txt`], { cwd: project.root, encoding: "utf8" }), "verified improvement\n");
});

test("auto-commit refuses a postimage changed between verification and staging", async (t) => {
  const project = makeGitProject(); t.after(project.cleanup);
  const { branch, head } = await ensureAutoCommitBranch(project.root, "dream-rsi/improve");
  const target = path.join(project.root, "solution.txt");
  const verified = "verified improvement\n";
  const altered = "concurrent replacement\n";
  fs.writeFileSync(target, verified);
  const originalRead = fsDefault.readFileSync;
  const originalWrite = fsDefault.writeFileSync;
  let replaced = false;
  fsDefault.readFileSync = function (file, ...args) {
    if (!replaced && path.resolve(String(file)) === target) {
      replaced = true;
      const bytes = originalRead.call(this, file, ...args);
      originalWrite.call(this, target, altered);
      return bytes;
    }
    return originalRead.call(this, file, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(commitVerifiedChanges({
      projectDir: project.root, branch, expectedHead: head,
      changes: [{ path: "solution.txt", afterHash: hash(verified) }],
      campaignId: "campaign-toctou", leverId: "lever-abc", unit: "ms", before: 100, after: 80,
      evidencePath: ".dream-rsi/campaigns/campaign-toctou",
    }), /staged postimage changed/i);
  } finally {
    fsDefault.readFileSync = originalRead;
    syncBuiltinESMExports();
  }
  assert.equal(replaced, true, "the test substituted bytes during file verification");
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: project.root, encoding: "utf8" }).trim(), head);
});

test("auto-commit refuses concurrent or altered changes without creating a commit", async (t) => {
  const project = makeGitProject(); t.after(project.cleanup);
  const { branch, head } = await ensureAutoCommitBranch(project.root, "dream-rsi/improve");
  const original = "verified improvement\n";
  fs.writeFileSync(path.join(project.root, "solution.txt"), original);
  const altered = "concurrent edit\n";
  const unrelated = "operator note\n";
  fs.writeFileSync(path.join(project.root, "solution.txt"), altered);
  fs.writeFileSync(path.join(project.root, "operator-notes.txt"), unrelated);
  await assert.rejects(commitVerifiedChanges({
    projectDir: project.root, branch, expectedHead: head,
    changes: [{ path: "solution.txt", afterHash: hash(original) }],
    campaignId: "campaign-123", leverId: "lever-abc", unit: "ms", before: 100, after: 80,
    evidencePath: ".dream-rsi/campaigns/campaign-123",
  }), /postimage changed/i);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: project.root, encoding: "utf8" }).trim(), head);
  assert.equal(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: project.root, encoding: "utf8" }).trim(), "");
  assert.equal(fs.readFileSync(path.join(project.root, "solution.txt"), "utf8"), altered, "the conflicting postimage remains untouched");
  assert.equal(fs.readFileSync(path.join(project.root, "operator-notes.txt"), "utf8"), unrelated, "an unrelated user change remains untouched");
});
