import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, matchesKey, Key } from "@earendil-works/pi-tui";
import { progressIterations, progressSummary, readProgress, type ProgressSnapshot } from "./engine/progress.ts";
import { attemptDir, roundDir } from "./engine/world.ts";

const clean = (s: string): string => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f]/g, " ");
/** Disk reads are bounded even for multi-gigabyte logs. Older pages are loaded only on request. */
export function readLogPage(file: string, before?: number): { text: string; start: number } {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const end = Math.min(before ?? Infinity, fs.fstatSync(fd).size);
      const start = Math.max(0, end - 64 * 1024);
      const buffer = Buffer.alloc(end - start); fs.readSync(fd, buffer, 0, buffer.length, start);
      const text = buffer.toString("utf8").split("\n").slice(-200).join("\n");
      const consumed = Buffer.byteLength(text);
      return { text, start: Math.max(start, end - consumed) };
    } finally { fs.closeSync(fd); }
  } catch { return { text: "(no log output yet)", start: 0 }; }
}

/** A read-only tree/log browser. Navigation never touches the engine's tree or budgets. */
export class DashboardView {
  iteration: number; nodeIndex = 0; pane = 0;
  private page: { text: string; start: number } | null = null;
  private snapshot: ProgressSnapshot | null = null;
  private signature = "";
  private preferredPhase: "live" | "dream" | undefined;
  private root: string;
  constructor(root: string, iteration?: number) {
    this.root = root;
    const iterations = progressIterations(root);
    this.iteration = iteration ?? iterations.find((i) => readProgress(root, i)?.status === "running") ?? iterations[0] ?? 0;
    this.refresh();
  }
  refresh(): boolean {
    const live = readProgress(this.root, this.iteration);
    const dream = readProgress(this.root, this.iteration, "dream");
    this.snapshot = this.preferredPhase === "dream" ? (dream ?? live) : this.preferredPhase === "live" ? (live ?? dream) :
      dream && (!live || dream.status === "running") ? dream : live;
    const signature = JSON.stringify(this.snapshot);
    const changed = signature !== this.signature; this.signature = signature;
    return changed;
  }
  private cells(): string[] {
    return [...new Set([...(this.snapshot?.tree?.cells.map((n) => n.meta.cell_id) ?? []), ...Object.keys(this.snapshot?.attempts ?? {})])];
  }
  handleInput(data: string): void {
    const cycles = progressIterations(this.root); const index = cycles.indexOf(this.iteration);
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      const next = matchesKey(data, Key.left) ? index + 1 : index - 1;
      this.iteration = cycles[Math.max(0, Math.min(cycles.length - 1, next))] ?? this.iteration;
      this.nodeIndex = 0; this.page = null; this.preferredPhase = undefined; this.refresh();
    } else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      this.nodeIndex = Math.max(0, Math.min(this.cells().length - 1, this.nodeIndex + (matchesKey(data, Key.up) ? -1 : 1))); this.page = null;
    } else if (matchesKey(data, "d")) {
      this.preferredPhase = this.snapshot?.phase === "dream" ? "live" : "dream";
      this.nodeIndex = 0; this.page = null; this.refresh();
    } else if (matchesKey(data, Key.tab)) { this.pane = (this.pane + 1) % 3; this.page = null; }
    else if (matchesKey(data, Key.pageUp)) { this.page = readLogPage(this.logFile(), this.page?.start); }
    else if (matchesKey(data, Key.pageDown)) this.page = null;
  }
  private logFile(): string {
    const cell = this.cells()[this.nodeIndex] ?? "";
    if (this.snapshot?.phase === "dream" && cell.startsWith("revision-")) {
      return path.join(roundDir(this.root, this.iteration, "dream"), `development_r${Number(cell.split("-")[1]) - 1}_agent.log`);
    }
    return path.join(attemptDir(this.root, this.iteration, cell), this.pane === 2 ? "eval.log" : "agent.log");
  }
  invalidate(): void {}
  render(width: number): string[] {
    const s = this.snapshot;
    if (!s) return ["Dream-RSI: no recorded progress. Esc closes."];
    const cells = this.cells(); const selected = cells[this.nodeIndex]; const attempt = s.attempts[selected];
    const rows = ["Dream-RSI watch   ←/→ cycle  ↑/↓ node  d live/dream  Tab pane  PgUp older  PgDn tail  Esc close", ...progressSummary(s).split("\n"), ""];
    const start = Math.max(0, this.nodeIndex - 5);
    for (const cell of cells.slice(start, start + 10)) {
      const a = s.attempts[cell]; const node = s.tree?.cells.find((n) => n.meta.cell_id === cell);
      rows.push(`${cell === selected ? ">" : " "} ${cell} ← ${a?.parent ?? node?.meta.parent_id ?? "root"}  ${a?.stage ?? "unopened"}  score=${a?.score ?? node?.score ?? "n/a"}${a?.retry ? ` retry=${a.retry}` : ""}`);
    }
    if (attempt) {
      const elapsed = attempt.stage === "agent" || attempt.stage === "evaluation" || attempt.stage === "preparing" ? Date.now() : attempt.updated_at;
      rows.push("", `${selected}: round ${attempt.round} | elapsed ${Math.max(0, Math.round((elapsed - attempt.started_at) / 1000))}s | ${attempt.error ?? ""}`);
    }
    if (this.pane === 0) rows.push("", "Tool activity", ...(attempt?.tools.length ? attempt.tools.slice(-8) : ["(no tool activity)"]));
    else {
      rows.push("", `${this.pane === 1 ? "Agent" : "Evaluator"} log ${this.page ? "(older page)" : "(tail)"}`);
      const tail = this.page?.text ?? (this.pane === 1 ? attempt?.agent_tail : attempt?.eval_tail);
      rows.push(...(tail || readLogPage(this.logFile()).text).split("\n").slice(-14));
    }
    return rows.map((r) => truncateToWidth(clean(r), Math.max(1, width)));
  }
}

export class Dashboard {
  private active = new Map<number, ProgressSnapshot>();
  private lastRender = 0;
  private closers = new Set<() => void>();
  private ctx: ExtensionContext;
  constructor(ctx: ExtensionContext) { this.ctx = ctx; }
  observe = (snapshot: ProgressSnapshot): void => {
    if (this.ctx.mode !== "tui") return;
    this.active.set(snapshot.iteration, snapshot);
    const final = snapshot.status !== "running";
    if (!final && Date.now() - this.lastRender < 250) return;
    this.lastRender = Date.now();
    this.ctx.ui.setWidget("dream-rsi", [...this.active.values()].flatMap((s) => progressSummary(s).split("\n").map(clean)));
    if (final) this.active.delete(snapshot.iteration);
  };
  async watch(root: string, iteration?: number): Promise<string | undefined> {
    if (this.ctx.mode !== "tui") {
      const view = new DashboardView(root, iteration);
      const summary = view.render(120).join("\n");
      this.ctx.ui.notify(summary, "info"); return summary;
    }
    await this.ctx.ui.custom<void>((tui, _theme, _keys, done) => {
      const view = new DashboardView(root, iteration);
      let closed = false;
      const close = (): void => { if (closed) return; closed = true; clearInterval(timer); this.closers.delete(close); done(); };
      const timer = setInterval(() => { view.refresh(); tui.requestRender(); }, 250);
      this.closers.add(close);
      return { render: (width: number) => view.render(width), invalidate: () => view.invalidate(),
        handleInput: (data: string) => {
          if (matchesKey(data, Key.escape)) close(); else { view.handleInput(data); tui.requestRender(); }
        }, dispose: close };
    }, { overlay: true, overlayOptions: { width: "95%", maxHeight: "90%", anchor: "center" } });
  }
  dispose(): void { for (const close of [...this.closers]) close(); this.active.clear(); if (this.ctx.mode === "tui") this.ctx.ui.setWidget("dream-rsi", undefined); }
}
