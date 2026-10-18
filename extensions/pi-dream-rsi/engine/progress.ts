import * as fs from "node:fs";
import * as path from "node:path";

import { readJson } from "./fsutil.ts";
import type { ExperimentNode, ExperimentWorld } from "./experiment.ts";

export interface ProgressAttempt {
  cell: string;
  parent: string;
  kind: "branch" | "refine";
  round: number;
  stage: string;
  retry: number;
  score: number | null;
  error: string | null;
  timedOut: boolean;
}

export interface ProgressSnapshot {
  version: 1;
  project: string;
  iteration: number;
  phase: "experiment";
  status: "running" | "complete" | "failed" | "interrupted";
  round: number;
  round_budget: number;
  workers: number;
  completed: number;
  best: number | null;
  activity: string;
  updated_at: number;
  attempts: Record<string, ProgressAttempt>;
  config: ExperimentWorld["config"];
}

export type ProgressObserver = (snapshot: ProgressSnapshot) => void;

export function progressPath(root: string, iteration: number): string {
  return path.join(root, "cycles", `c${String(iteration).padStart(4, "0")}`, "progress.json");
}

function snapshotFromWorld(root: string, world: ExperimentWorld): ProgressSnapshot {
  const attempts: Record<string, ProgressAttempt> = {};
  for (const node of world.nodes) attempts[node.id] = {
    cell: node.id, parent: node.parent ?? "root", kind: node.kind, round: node.round, stage: node.stage,
    retry: Math.max(0, node.retries - 1), score: node.score, error: node.error ?? null, timedOut: node.timedOut,
  };
  const validScores = world.nodes.flatMap((node) => node.valid && typeof node.score === "number" ? [node.score] : []);
  return {
    version: 1, project: root, iteration: world.cycle, phase: "experiment", status: world.status,
    round: world.rounds, round_budget: world.config.maxRounds, workers: world.config.batchSize,
    completed: world.nodes.filter((node) => node.stage === "done").length,
    best: validScores.length ? Math.max(world.baseline, ...validScores) : world.baseline,
    activity: world.stopped ?? (world.status === "running" ? "experiment running" : "experiment recorded"),
    updated_at: Date.now(), attempts, config: world.config,
  };
}

export function readProgress(root: string, iteration: number): ProgressSnapshot | null {
  const saved = readJson<ProgressSnapshot>(progressPath(root, iteration));
  if (saved?.version === 1) return saved;
  const world = readJson<ExperimentWorld>(path.join(root, "cycles", `c${String(iteration).padStart(4, "0")}`, "world.json"));
  return world?.version === 1 ? snapshotFromWorld(root, world) : null;
}

export function progressIterations(root: string): number[] {
  const dir = path.join(root, "cycles");
  try {
    return fs.readdirSync(dir).flatMap((entry) => {
      const match = /^c(\d+)$/.exec(entry);
      return match && fs.statSync(path.join(dir, entry)).isDirectory() ? [Number(match[1])] : [];
    }).sort((a, b) => b - a);
  } catch { return []; }
}

export function progressSummary(snapshot: ProgressSnapshot): string {
  const active = Object.values(snapshot.attempts).filter((attempt) => attempt.stage !== "done").length;
  return `experiment ${snapshot.iteration}: ${snapshot.status} | round ${snapshot.round}/${snapshot.round_budget} | attempts ${active} active | completed ${snapshot.completed} | best ${snapshot.best ?? "n/a"}\n${snapshot.activity}`;
}

export function progressFromWorld(root: string, world: ExperimentWorld): ProgressSnapshot {
  return snapshotFromWorld(root, world);
}

export function nodeFromProgress(snapshot: ProgressSnapshot, node: ExperimentNode): ProgressAttempt {
  return snapshot.attempts[node.id] ?? { cell: node.id, parent: node.parent ?? "root", kind: node.kind, round: node.round,
    stage: node.stage, retry: node.retries, score: node.score, error: node.error ?? null, timedOut: node.timedOut };
}
