import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, matchesKey, Key } from "@earendil-works/pi-tui";
import { progressIterations, progressSummary, readProgress, type ProgressSnapshot } from "./engine/progress.ts";

const clean = (s: string): string => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f]/g, " ");
type RowKind = "title" | "section" | "row" | "selected" | "live" | "ok" | "warn" | "error" | "muted";
export interface LoopWatchSnapshot { lines: string[]; campaignRoot: string | null }
interface DashboardRow { kind: RowKind; text: string; log?: boolean; tree?: boolean }
interface CampaignDisplayMetadata {
  id: string;
  maxCycles: number;
  phase?: string;
  iteration?: number;
  completedCycles: number[];
  searchConfig?: { batchSize: number; exploreShare: number; refineTop: number; maxRounds: number; patience: number };
  adoptedAt?: string;
}

function rowKind(text: string): RowKind {
  if (/^(Tool activity|Agent log|Evaluator log)/i.test(text)) return "section";
  if (/\b(error|timeout|fail(?:ed|ure)?|rejected)\b/i.test(text)) return "error";
  if (/\b(agent|evaluation|running|preparing)\b/i.test(text)) return "warn";
  if (/\b(ok|applied|complete|success)\b/i.test(text)) return "ok";
  if (/\b(unopened|n\/a)\b/i.test(text)) return "muted";
  return "row";
}

function campaignDisplayMetadata(root: string, fallbackCycle: number, cycleCount: number): CampaignDisplayMetadata {
  let id = path.basename(root);
  let maxCycles = Math.max(cycleCount, 1);
  let phase: string | undefined;
  let iteration: number | undefined;
  let completedCycles: number[] = [];
  let searchConfig: CampaignDisplayMetadata["searchConfig"];
  let adoptedAt: string | undefined;
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(root, "campaign.json"), "utf8"));
    if (typeof value === "object" && value !== null) {
      const record = value as { id?: unknown; limits?: { maxCycles?: unknown }; state?: { kind?: unknown; phase?: unknown; iteration?: unknown }; completedCycles?: unknown; searchConfig?: CampaignDisplayMetadata["searchConfig"] };
      if (typeof record.id === "string" && record.id.length > 0) id = record.id;
      if (typeof record.limits?.maxCycles === "number" && Number.isFinite(record.limits.maxCycles) && record.limits.maxCycles > 0) maxCycles = Math.floor(record.limits.maxCycles);
      if (typeof record.state?.phase === "string") phase = record.state.phase;
      else if (typeof record.state?.kind === "string") phase = record.state.kind;
      if (typeof record.state?.iteration === "number" && Number.isFinite(record.state.iteration)) iteration = record.state.iteration;
      if (Array.isArray(record.completedCycles)) completedCycles = record.completedCycles.filter((cycle): cycle is number => typeof cycle === "number" && Number.isFinite(cycle));
      if (record.searchConfig && Number.isFinite(record.searchConfig.batchSize) && Number.isFinite(record.searchConfig.exploreShare)
        && Number.isFinite(record.searchConfig.refineTop) && Number.isFinite(record.searchConfig.maxRounds)
        && Number.isFinite(record.searchConfig.patience)) searchConfig = record.searchConfig;
      if (searchConfig) {
        const dreamsFile = path.join(path.dirname(root), "..", "loop", "dreams.jsonl");
        try {
          const lines = fs.readFileSync(dreamsFile, "utf8").trim().split(/\r?\n/).slice(-100);
          for (const line of lines.reverse()) {
            const dream = JSON.parse(line) as { at?: unknown; adopted?: unknown };
            if (typeof dream.at === "string" && JSON.stringify(dream.adopted) === JSON.stringify(searchConfig)) { adoptedAt = dream.at; break; }
          }
        } catch { /* No adoption record means this campaign uses the incumbent config. */ }
      }
    }
  } catch { /* A missing campaign record falls back to the observed progress. */ }
  return { id: id.slice(0, 8), maxCycles, phase, iteration: iteration ?? fallbackCycle, completedCycles, searchConfig, adoptedAt };
}

function selectedRejections(root: string, iteration: number, cell: string): { stage: string; reasons: string[] }[] {
  if (!cell) return [];
  const file = path.join(root, "history", "ledger.jsonl");
  const { text } = readLogPage(file);
  const matches = text.split("\n").flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null) return [];
      const item = value as { kind?: unknown; outcome?: unknown; facts?: { cell?: unknown; terminalStage?: unknown; reason?: unknown; iteration?: unknown } };
      if (item.kind !== "skip" || item.outcome !== "rejected" || item.facts?.cell !== cell || item.facts.iteration !== iteration || typeof item.facts.terminalStage !== "string" || typeof item.facts.reason !== "string") return [];
      return [{ stage: item.facts.terminalStage, reasons: [item.facts.reason] }];
    } catch { return []; }
  });
  return matches.slice(-3);
}

function restoreBackground(text: string, bgAnsi: string): string {
  return text.replace(/\x1b\[0m/g, `\x1b[0m${bgAnsi}`);
}
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
  private root: string;
  private fallbackRoot: string;
  private loopSnapshot: LoopWatchSnapshot | null = null;
  private loopSource?: () => LoopWatchSnapshot;
  constructor(root: string, iteration?: number, loopSource?: () => LoopWatchSnapshot) {
    this.root = root;
    this.fallbackRoot = root;
    this.loopSource = loopSource;
    const iterations = progressIterations(root);
    this.iteration = iteration ?? iterations.find((i) => readProgress(root, i)?.status === "running") ?? iterations[0] ?? 0;
    this.refresh();
  }
  refresh(): boolean {
    this.loopSnapshot = this.loopSource?.() ?? null;
    const nextRoot = this.loopSnapshot?.campaignRoot ?? this.fallbackRoot;
    if (nextRoot !== this.root) {
      this.root = nextRoot;
      const iterations = progressIterations(nextRoot);
      this.iteration = iterations.find((i) => readProgress(nextRoot, i)?.status === "running") ?? iterations[0] ?? 0;
      this.nodeIndex = 0; this.page = null;
    }
    this.snapshot = readProgress(this.root, this.iteration);
    const signature = JSON.stringify([this.loopSnapshot, this.snapshot]);
    const changed = signature !== this.signature; this.signature = signature;
    return changed;
  }
  private cells(): string[] {
    return Object.keys(this.snapshot?.attempts ?? {});
  }
  handleInput(data: string): void {
    const cycles = progressIterations(this.root); const index = cycles.indexOf(this.iteration);
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      const next = matchesKey(data, Key.left) ? index + 1 : index - 1;
      this.iteration = cycles[Math.max(0, Math.min(cycles.length - 1, next))] ?? this.iteration;
      this.nodeIndex = 0; this.page = null; this.refresh();
    } else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      this.nodeIndex = Math.max(0, Math.min(this.cells().length - 1, this.nodeIndex + (matchesKey(data, Key.up) ? -1 : 1))); this.page = null;
    } else if (matchesKey(data, Key.tab)) { this.pane = (this.pane + 1) % 4; this.page = null; }
    else if (matchesKey(data, Key.pageUp)) { this.page = readLogPage(this.logFile(), this.page?.start); }
    else if (matchesKey(data, Key.pageDown)) this.page = null;
  }
  private logFile(): string {
    const cell = this.cells()[this.nodeIndex] ?? "";
    return path.join(this.root, "cycles", `c${String(this.iteration).padStart(4, "0")}`, "attempts", cell, this.pane === 2 ? "eval.log" : "agent.log");
  }
  invalidate(): void {}
  private rows(): DashboardRow[] {
    const s = this.snapshot;
    const live: DashboardRow[] = (this.loopSnapshot?.lines ?? []).map((text) => ({ kind: "live", text }));
    if (!s) return this.loopSnapshot
      ? [{ kind: "title", text: "Dream-RSI loop watch" }, ...live, { kind: "muted", text: "No campaign progress is available. Loop status is shown above. Esc closes." }]
      : [{ kind: "muted", text: "Dream-RSI: no recorded progress. Esc closes." }];
    const cells = this.cells(); const selected = cells[this.nodeIndex]; const attempt = s.attempts[selected];
    const rows: DashboardRow[] = [
      { kind: "title", text: `Dream-RSI watch: ${this.root} | ←/→ cycle  ↑/↓ attempt  Tab attempt/agent/eval/runs  PgUp older  PgDn tail  Esc close` },
      ...live,
      ...progressSummary(s).split("\n").map((text) => ({ kind: rowKind(text), text })),
      { kind: "row", text: "" },
    ];
    const start = Math.max(0, this.nodeIndex - 5);
    for (const cell of cells.slice(start, start + 10)) {
      const a = s.attempts[cell];
      const timeout = a?.timedOut ? " [timedOut]" : "";
      const text = `${cell === selected ? ">" : " "} ${cell} ← ${a?.parent ?? "root"} ${a?.kind ?? "branch"} r${a?.round ?? "?"} ${a?.stage ?? "unopened"} score=${a?.score ?? "n/a"}${timeout}${a?.retry ? ` retry=${a.retry}` : ""}`;
      rows.push({ kind: cell === selected ? "selected" : rowKind(text), text, tree: true });
    }
    if (attempt) {
      rows.push({ kind: "row", text: "" }, { kind: rowKind(attempt.error ?? ""), text: `${selected}: round ${attempt.round} | ${attempt.error ?? ""}` });
    }
    if (this.pane === 0) {
      rows.push({ kind: "row", text: "" }, { kind: "section", text: "Attempt" }, { kind: rowKind(attempt?.stage ?? ""), text: attempt ? `${attempt.kind} from ${attempt.parent}: ${attempt.stage}` : "(no attempt selected)" });
    } else if (this.pane === 3) {
      const attempts = Object.values(s.attempts).sort((a, b) => (a.seq ?? a.round) - (b.seq ?? b.round));
      const baseline = s.baseline;
      const score = (value: number | null | undefined): string => typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(3)).toString() : "—";
      rows.push({ kind: "row", text: "" }, { kind: "section", text: `Candidate runs · ${attempts.length} total · valid scores are not automatically applied` },
        { kind: "muted", text: "#  ID  kind   parent  stage       score   Δ baseline  outcome" });
      for (const item of attempts.slice(-12)) {
        const measuredScore = item.valid === true ? item.score : null;
        const delta = baseline !== undefined && measuredScore !== null ? measuredScore - baseline : null;
        const deltaText = delta === null ? "—" : `${delta >= 0 ? "+" : ""}${score(delta)}`;
        const outcome = item.stage !== "done" ? item.stage
          : item.agentError === true && item.edited !== true ? "agent error"
            : item.timedOut ? item.valid === true ? "timeout · valid" : "timeout"
              : item.valid === true ? "valid"
                : item.failClass && item.failClass !== "ok" ? `invalid/${item.failClass}` : "invalid";
        const line = `${String(item.seq ?? item.round).padStart(2, "0")} ${item.cell} ${item.kind.padEnd(6)} ${item.parent.padEnd(6)} ${item.stage.padEnd(10)} ${score(measuredScore).padStart(7)} ${deltaText.padStart(10)}  ${outcome}`;
        rows.push({ kind: item.cell === selected ? "selected" : rowKind(outcome), text: line, tree: true });
      }
    } else {
      rows.push({ kind: "row", text: "" }, { kind: "section", text: `${this.pane === 1 ? "Agent" : "Evaluator"} log ${this.page ? "(older page)" : "(tail)"}` });
      const tail = this.page?.text ?? readLogPage(this.logFile()).text;
      rows.push(...tail.split("\n").slice(-14).map((text) => ({ kind: rowKind(text), text, log: true })));
    }
    rows.push(...selectedRejections(this.root, this.iteration, selected).flatMap(({ stage, reasons }) => [
      { kind: "section" as const, text: `Rejection · ${stage}` },
      ...reasons.map((text) => ({ kind: "error" as const, text })),
    ]));
    return rows;
  }
  plain(width: number): string[] {
    return this.rows().map(({ text }) => truncateToWidth(clean(text), Math.max(1, width)));
  }
  render(width: number): string[] { return this.plain(width); }

  framed(width: number, theme: Theme | undefined, maxRows: number): string[] {
    if (typeof theme?.fg !== "function" || width < 4) return this.plain(width);
    const cycleCount = progressIterations(this.root).length;
    const metadata = campaignDisplayMetadata(this.root, this.iteration || cycleCount || 1, cycleCount);
    const currentCycle = metadata.iteration ?? this.iteration ?? 1;
    const currentPhase = metadata.phase ?? this.snapshot?.phase ?? "ready";
    const config = metadata.searchConfig ? ` · search b${metadata.searchConfig.batchSize}/e${metadata.searchConfig.exploreShare}/r${metadata.searchConfig.refineTop}×${metadata.searchConfig.maxRounds}/p${metadata.searchConfig.patience}` : "";
    const adopted = metadata.adoptedAt ? ` · adopted ${metadata.adoptedAt.slice(0, 10)}` : "";
    const title = this.loopSnapshot && !this.snapshot ? "Dream-RSI · loop activity" : `Dream-RSI · ${metadata.id} · cycle ${currentCycle}/${metadata.maxCycles} · ${currentPhase}${config}${adopted}`;
    const currentRows = this.rows();
    const body = this.snapshot || this.loopSnapshot ? currentRows.slice(1) : currentRows;
    if (!this.snapshot && !this.loopSnapshot) body[0] = { kind: "muted", text: "No recorded progress. Esc closes." };
    const footer: DashboardRow = { kind: "muted", text: "←/→ cycle · ↑/↓ attempt · Tab attempt/agent/eval/runs · PgUp/PgDn logs · Esc close" };
    const cap = Math.max(1, Math.floor(maxRows));
    const height = Math.min(cap, Math.max(body.length + 3, 20));
    if (height < 3) {
      const short = cap <= 1
        ? [truncateToWidth(clean(title), Math.max(1, width))]
        : [truncateToWidth(clean(title), Math.max(1, width)), truncateToWidth("╰" + "─".repeat(Math.max(0, width - 2)) + "╯", Math.max(1, width))];
      return short.slice(0, cap);
    }
    const bodyCapacity = Math.max(0, height - 2);
    while (body.length + 1 > bodyCapacity) {
      const logIndex = body.findIndex((row) => row.log);
      if (logIndex >= 0) { body.splice(logIndex, 1); continue; }
      const dropIndex = body.findIndex((row) => row.tree && row.kind !== "selected");
      if (dropIndex >= 0) { body.splice(dropIndex, 1); continue; }
      const otherIndex = body.findIndex((row) => row.kind !== "selected" && row.kind !== "section" && row.kind !== "live");
      if (otherIndex >= 0) { body.splice(otherIndex, 1); continue; }
      body.pop();
    }
    const interior: DashboardRow[] = [...body, footer];
    while (interior.length < bodyCapacity) interior.push({ kind: "row", text: "" });
    const border = (value: string): string => theme.fg("border", value);
    const innerWidth = Math.max(0, width - 2);
    const titleText = truncateToWidth(theme.bold(theme.fg("accent", clean(title))), Math.max(0, width - 3), "", false);
    const titlePadding = Math.max(0, width - 3 - visibleWidth(titleText));
    const topRaw = `${border("╭")}${border("─")}${titleText}${border("─".repeat(titlePadding))}${border("╮")}`;
    const bottomRaw = `${border("╰")}${border("─").repeat(Math.max(0, width - 2))}${border("╯")}`;
    const paintBg = (text: string, background: "customMessageBg" | "selectedBg" = "customMessageBg"): string => {
      const bg = theme.getBgAnsi(background);
      const wrapped = theme.bg(background, text);
      return `${restoreBackground(wrapped, bg)}\x1b[0m`;
    };
    const frameLine = (raw: string): string => {
      const fitted = truncateToWidth(raw, width, "", true);
      return paintBg(fitted, "customMessageBg");
    };
    const renderRow = (row: DashboardRow): string => {
      const raw = clean(row.text);
      const defaultColor: "accent" | "success" | "warning" | "error" | "muted" | "text" = row.kind === "section" || row.kind === "title" ? "accent"
        : row.kind === "ok" ? "success"
          : row.kind === "warn" || row.kind === "live" ? "warning"
            : row.kind === "error" ? "error"
              : row.kind === "muted" ? "muted" : "text";
      const colorStatus = (status: string): "warning" | "success" | "muted" | "error" => {
        if (/^(running|agent|evaluation|preparing)$/i.test(status)) return "warning";
        if (/^(ok|applied|complete|success)$/i.test(status)) return "success";
        if (/^(unopened|n\/a)$/i.test(status)) return "muted";
        return "error";
      };
      const statusPattern = /\b(running|agent|evaluation|preparing|ok|applied|complete|success|unopened|n\/a|failed|failure|error|timeout|rejected)\b/gi;
      const chunks: string[] = [];
      let offset = 0;
      for (const match of raw.matchAll(statusPattern)) {
        const index = match.index ?? 0;
        if (index > offset) chunks.push(theme.fg(defaultColor, raw.slice(offset, index)));
        chunks.push(theme.fg(colorStatus(match[0]), match[0]));
        offset = index + match[0].length;
      }
      if (offset < raw.length) chunks.push(theme.fg(defaultColor, raw.slice(offset)));
      const colored = chunks.join("");
      const fitted = truncateToWidth(colored, innerWidth, "…", true);
      const background = row.kind === "selected" ? "selectedBg" : "customMessageBg";
      const inner = paintBg(fitted, background);
      const whole = `${border("│")}${inner}${border("│")}`;
      return paintBg(whole, "customMessageBg");
    };
    return [frameLine(topRaw), ...interior.map(renderRow), frameLine(bottomRaw)];
  }
}

export class Dashboard {
  private active = new Map<string, ProgressSnapshot>();
  private lastRender = 0;
  private closers = new Set<() => void>();
  private ctx: ExtensionContext;
  constructor(ctx: ExtensionContext) { this.ctx = ctx; }
  observe = (snapshot: ProgressSnapshot): void => {
    if (this.ctx.mode !== "tui") return;
    const key = `${snapshot.project}:${snapshot.iteration}`;
    this.active.set(key, snapshot);
    const final = snapshot.status !== "running";
    if (!final && Date.now() - this.lastRender < 250) return;
    this.lastRender = Date.now();
    if (final) this.active.delete(key);
    const rows = [...this.active.values()].flatMap((s) => progressSummary(s).split("\n").map(clean));
    this.ctx.ui.setWidget("dream-rsi", rows.length > 0 ? rows : undefined);
  };
  async watch(root: string, iteration?: number, loopSource?: () => LoopWatchSnapshot): Promise<string | undefined> {
    if (this.ctx.mode !== "tui") {
      const view = new DashboardView(root, iteration, loopSource);
      const summary = view.render(120).join("\n");
      this.ctx.ui.notify(summary, "info"); return summary;
    }
    await this.ctx.ui.custom<void>((tui, theme, _keys, done) => {
      const view = new DashboardView(root, iteration, loopSource);
      let closed = false;
      const close = (): void => { if (closed) return; closed = true; clearInterval(timer); this.closers.delete(close); done(); };
      const timer = setInterval(() => { view.refresh(); tui.requestRender(); }, 250);
      this.closers.add(close);
      return { render: (width: number) => typeof theme?.fg === "function" ? view.framed(width, theme, Math.floor((tui.terminal?.rows ?? 40) * 0.9)) : view.plain(width), invalidate: () => view.invalidate(),
        handleInput: (data: string) => {
          if (matchesKey(data, Key.escape)) close(); else { view.handleInput(data); tui.requestRender(); }
        }, dispose: close };
    }, { overlay: true, overlayOptions: { width: "95%", maxHeight: "90%", anchor: "center" } });
  }
  dispose(): void { for (const close of [...this.closers]) close(); this.active.clear(); if (this.ctx.mode === "tui") this.ctx.ui.setWidget("dream-rsi", undefined); }
}
