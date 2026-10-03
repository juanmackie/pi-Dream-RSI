import * as fs from "node:fs";
import * as path from "node:path";
import { BoundedTail, type OutputEvent } from "../agent/output.ts";
import { iterationDir, readJson, writeFileAtomic, tracePoolDir, readManifest } from "./world.ts";
import type { TreeJSON } from "./tree.ts";

export type Stage = "preparing" | "agent" | "evaluation" | "complete" | "failed" | "interrupted";
export interface AttemptProgress {
  cell: string; parent: string; round: number; stage: Stage; retry: number;
  started_at: number; updated_at: number; score: number | null; error: string | null;
  agent_tail: string; eval_tail: string; tools: string[];
}
export interface ProgressSnapshot {
  version: 1; project: string; iteration: number; phase: "live" | "dream";
  status: "running" | "complete" | "failed" | "interrupted";
  round: number; round_budget: number; workers: number; completed: number;
  best: number | null; activity: string; updated_at: number;
  attempts: Record<string, AttemptProgress>; tree?: TreeJSON;
}
export type ProgressObserver = (snapshot: ProgressSnapshot) => void;
export function progressPath(root: string, iteration: number, phase: "live" | "dream" = "live"): string {
  return path.join(iterationDir(root, iteration, true), `${phase}_progress.json`);
}

/** Telemetry has no authority over policy execution. Durable checkpoints are written separately. */
export class ProgressRecorder {
  snapshot: ProgressSnapshot;
  private lastWrite = 0;
  private tails = new Map<string, BoundedTail>();
  private observer?: ProgressObserver;
  constructor(root: string, iteration: number, phase: "live" | "dream", rounds: number, workers: number,
    observer?: ProgressObserver) {
    this.observer = observer;
    this.snapshot = { version: 1, project: root, iteration, phase, status: "running", round: 0,
      round_budget: rounds, workers, completed: 0, best: null, activity: "starting", updated_at: Date.now(), attempts: {} };
  }
  flush(force = false): void {
    this.snapshot.updated_at = Date.now();
    if (!force && this.snapshot.updated_at - this.lastWrite < 250) return;
    this.lastWrite = this.snapshot.updated_at;
    try { writeFileAtomic(progressPath(this.snapshot.project, this.snapshot.iteration, this.snapshot.phase), JSON.stringify(this.snapshot)); } catch { /* checkpoint handles durability */ }
    try { this.observer?.(this.snapshot); } catch { /* display failure never changes the run */ }
  }
  stage(cell: string, parent: string, round: number, stage: Stage, retry = 0, score: number | null = null, error: string | null = null): void {
    const before = this.snapshot.attempts[cell];
    this.snapshot.attempts[cell] = { cell, parent, round, stage, retry, score, error,
      started_at: before?.started_at ?? Date.now(), updated_at: Date.now(),
      agent_tail: before?.agent_tail ?? "", eval_tail: before?.eval_tail ?? "", tools: before?.tools ?? [] };
    this.snapshot.round = round;
    this.snapshot.completed = Object.values(this.snapshot.attempts).filter((a) => a.stage === "complete" || a.stage === "failed").length;
    this.snapshot.activity = `${cell}: ${stage}${retry ? ` (retry ${retry})` : ""}`;
    this.flush(["complete", "failed", "interrupted"].includes(stage));
  }
  output(cell: string, evaluation: boolean, event: OutputEvent): void {
    const attempt = this.snapshot.attempts[cell]; if (!attempt) return;
    const key = `${cell}:${evaluation ? "eval" : "agent"}`;
    let tail = this.tails.get(key); if (!tail) { tail = new BoundedTail(); tail.append(evaluation ? attempt.eval_tail : attempt.agent_tail); this.tails.set(key, tail); }
    const text = event.kind === "text" ? event.text : `\n[${event.kind} ${event.toolName ?? event.toolId ?? "tool"}] ${event.text}\n`;
    tail.append(text);
    if (evaluation) attempt.eval_tail = tail.text; else attempt.agent_tail = tail.text;
    if (event.kind !== "text") attempt.tools = [...attempt.tools, `${event.kind} ${event.toolName ?? event.toolId ?? "tool"}`].slice(-20);
    this.snapshot.activity = `${cell}: ${event.kind === "text" ? (evaluation ? "evaluator output" : "agent output") : event.kind + " " + (event.toolName ?? "tool")}`;
    attempt.updated_at = Date.now(); this.flush();
  }
  activity(text: string): void { this.snapshot.activity = text; this.flush(true); }
  finish(status: ProgressSnapshot["status"]): void { this.snapshot.status = status; this.flush(true); }
}

export function readProgress(root: string, iteration: number, phase: "live" | "dream" = "live"): ProgressSnapshot | null {
  const saved = readJson<ProgressSnapshot>(progressPath(root, iteration, phase));
  if (saved?.version === 1) return saved;
  if (phase === "dream") return null;
  const manifest = readManifest(root, iteration) ?? readJson<any>(path.join(iterationDir(root, iteration, true), "live_cycle_manifest.json"));
  if (!manifest) return null;
  const tree = readJson<TreeJSON>(path.join(iterationDir(root, iteration), "tree.json"));
  return { version: 1, project: root, iteration, phase, status: manifest.status, round: manifest.decision_rounds ?? 0,
    round_budget: manifest.decision_rounds ?? 0, workers: manifest.grid?.branch_count ?? 0, completed: manifest.attempts ?? 0,
    best: manifest.best_score, activity: manifest.error ?? "recorded cycle (legacy)", updated_at: Date.parse(manifest.completed_at ?? manifest.created_at),
    tree: tree ?? undefined, attempts: Object.fromEntries((tree?.cells ?? []).map((n) => [n.meta.cell_id, {
      cell: n.meta.cell_id, parent: n.meta.parent_id ?? "root", round: 0, stage: n.evaluated ? (n.error ? "failed" : "complete") : "preparing",
      retry: 0, started_at: 0, updated_at: 0, score: n.score, error: n.error, agent_tail: "", eval_tail: "", tools: [] }])) };
}
export function progressIterations(root: string): number[] {
  try { return [...new Set(fs.readdirSync(tracePoolDir(root)).flatMap((e) => { const m = /^iter(\d+)(?:_current)?$/.exec(e); return m ? [Number(m[1])] : []; }))].sort((a, b) => b - a); }
  catch { return []; }
}
export function progressSummary(s: ProgressSnapshot): string {
  const active = Object.values(s.attempts).filter((a) => ["preparing", "agent", "evaluation"].includes(a.stage)).length;
  return `${s.phase} ${s.iteration}: ${s.status} | round ${s.round}/${s.round_budget} | workers ${active}/${s.workers} | completed ${s.completed} | ${s.phase === "dream" ? "best V" : "best"} ${s.best ?? "n/a"}\n${s.activity}`;
}
