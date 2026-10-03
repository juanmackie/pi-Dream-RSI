import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { copyWorkspace, type CommandResult, type OwnedChild } from "../agent/runner.ts";
import { readPolicyViolations } from "../policy/runner.ts";
import type { RevealedNode } from "../policy/host.ts";
import type { PolicyRunResult } from "../policy/runner.ts";
import type { TaskConfig } from "./task.ts";
import { scoringFingerprint, normalizeTask } from "./task.ts";
import type { TreeJSON } from "./tree.ts";
import { iterationDir, nodeWorkspace, readManifest, writeFileAtomic, type LiveCycleManifest } from "./world.ts";

export interface PreparedAttempt {
  cell: string; parentCell: string; workspace: string; workspaceRel: string;
  prompt: string; promptPath: string; logPath: string; round: number;
}
export interface PendingAttempt {
  cell: string; parentCell: string; parentWorkspace: string;
  stage: "preparing" | "agent" | "evaluation" | "complete";
  process?: OwnedChild;
  retry: number; prepared?: PreparedAttempt; agentRun?: CommandResult;
  workspace_hash?: string; agent_snapshot?: string; record: RevealedNode | null;
}
export interface SavedBatch { round: number; cells: string[]; attempts: PendingAttempt[] }
export interface LiveCheckpoint {
  version: 1; project: string; task: TaskConfig; manifest: LiveCycleManifest;
  policy: string; policy_hashes: Record<string, string>; seed: string; seed_hash: string;
  prompt_template: string; prompt_vars: Record<string, string>;
  tree: TreeJSON; batches: SavedBatch[]; status: "running" | "interrupted" | "complete";
  extra_agent_calls: number; extra_eval_calls: number; resumes: number;
  final?: PolicyRunResult;
}
const hash = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
export function checkpointPath(root: string, iteration: number): string { return path.join(iterationDir(root, iteration, true), "checkpoint.json"); }
export function saveCheckpoint(root: string, cp: LiveCheckpoint): void {
  const data = JSON.stringify(cp);
  writeFileAtomic(checkpointPath(root, cp.manifest.iteration), JSON.stringify({ version: 1, checksum: hash(data), data }), true);
}
export function readCheckpoint(root: string, iteration: number): LiveCheckpoint {
  const envelope = JSON.parse(fs.readFileSync(checkpointPath(root, iteration), "utf8"));
  if (envelope.version !== 1 || typeof envelope.data !== "string" || hash(envelope.data) !== envelope.checksum) throw new Error("checkpoint checksum/version mismatch");
  const cp: LiveCheckpoint = JSON.parse(envelope.data);
  if (cp.version !== 1 || cp.manifest.iteration !== iteration || !Array.isArray(cp.batches)) throw new Error("invalid live checkpoint");
  return cp;
}
/** Stable contents hash: detects deleted/edited recovery snapshots before any new paid call. */
export async function workspaceHash(root: string): Promise<string> {
  const digest = createHash("sha256");
  const walk = async (dir: string, relative: string): Promise<void> => {
    const stat = await fs.promises.lstat(dir); digest.update(relative + "\0");
    if (stat.isSymbolicLink()) { digest.update("link:" + await fs.promises.readlink(dir)); return; }
    if (stat.isDirectory()) {
      digest.update("dir");
      for (const name of (await fs.promises.readdir(dir)).sort()) await walk(path.join(dir, name), path.join(relative, name));
    } else {
      digest.update("file");
      for await (const chunk of fs.createReadStream(dir)) digest.update(chunk as Buffer);
    }
  };
  await walk(root, ""); return digest.digest("hex");
}
/** Freeze the entire permitted relative-import closure with its directory structure. */
export function freezePolicy(policy: string, destination: string): Record<string, string> {
  const violations = readPolicyViolations(policy); if (violations.length) throw new Error(violations.join("; "));
  const files = new Map<string, string>();
  const walk = (file: string): void => {
    if (files.has(file)) return;
    const source = fs.readFileSync(file, "utf8"); files.set(file, source);
    for (const match of source.matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const next = path.resolve(path.dirname(file), match[1]);
      if (fs.existsSync(next)) walk(next);
    }
  };
  walk(path.resolve(policy));
  // Type-only imports can point outside policy/; keep the whole common ancestor layout.
  let base = path.dirname(path.resolve(policy));
  while ([...files.keys()].some((f) => {
    const relative = path.relative(base, f);
    return relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative);
  })) {
    const parent = path.dirname(base);
    if (parent === base) throw new Error("policy import closure crosses filesystem volumes");
    base = parent;
  }
  const hashes: Record<string, string> = {};
  for (const [file, source] of files) {
    const target = path.join(destination, path.relative(base, file));
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, source);
    hashes[target] = hash(source);
  }
  fs.writeFileSync(path.join(destination, "package.json"), '{"type":"module","private":true}');
  const entry = path.join(destination, path.relative(base, path.resolve(policy)));
  // Entry first gives the caller a stable way to identify it.
  return { [entry]: hashes[entry], ...hashes };
}
export async function validateCheckpoint(root: string, project: string, currentTask: TaskConfig, iteration: number): Promise<LiveCheckpoint> {
  const cp = readCheckpoint(root, iteration);
  if (cp.project !== path.resolve(project)) throw new Error("checkpoint belongs to a different project");
  normalizeTask(cp.task);
  if (scoringFingerprint(currentTask) !== scoringFingerprint(cp.task)) throw new Error("scoring/execution contract changed; restore the original task before resuming");
  for (const [file, expected] of Object.entries(cp.policy_hashes)) {
    if (hash(fs.readFileSync(file)) !== expected) throw new Error(`frozen policy changed: ${file}`);
  }
  if (!cp.policy_hashes[cp.policy] || cp.tree.version !== 1) throw new Error("checkpoint missing frozen policy/tree");
  if (await workspaceHash(cp.seed) !== cp.seed_hash) throw new Error("seed snapshot changed or is corrupt");
  for (const batch of cp.batches) {
    if (batch.cells.length !== batch.attempts.length || batch.cells.length === 0) throw new Error("invalid saved batch");
    for (const attempt of batch.attempts) {
      if (attempt.record || attempt.stage === "evaluation") {
        const workspace = attempt.stage === "evaluation" ? attempt.agent_snapshot : nodeWorkspace(root, iteration, attempt.cell);
        if (!workspace) throw new Error("missing agent snapshot");
        if (attempt.workspace_hash && await workspaceHash(workspace) !== attempt.workspace_hash) throw new Error(`saved workspace changed: ${attempt.cell}`);
        if (attempt.stage === "evaluation" && (!attempt.agentRun || !attempt.prepared)) throw new Error("missing agent completion record");
      }
    }
  }
  return cp;
}
export async function snapshotSeed(from: string, to: string, excluded: string[]): Promise<string> {
  await copyWorkspace(from, to, { exclude: excluded }); return workspaceHash(to);
}
export function recoverableIterations(root: string): number[] {
  try {
    return fs.readdirSync(path.join(root, "trace_pool")).flatMap((e) => {
      const m = /^iter(\d+)_current$/.exec(e); if (!m) return [];
      try { const cp = readCheckpoint(root, Number(m[1])); const published = readManifest(root, Number(m[1]))?.status === "complete";
        return cp.status !== "complete" || !published ? [Number(m[1])] : []; } catch { return []; }
    }).sort((a, b) => b - a);
  } catch { return []; }
}
