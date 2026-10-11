/** A compact, prompt-only view of durable Dream-RSI state. */
export const HANDOFF_MAX_CHARS = 6_000;
export const HANDOFF_MAX_RUN_ENTRIES = 8;

export interface HandoffDetails {
  iteration?: number;
  kind?: "active" | "recoverable";
  owner?: string;
  checkpoint?: string;
}

/** Keep current/recoverable state and the newest results while leaving full history on disk. */
export function renderHandoffSummary(summary: string, details: HandoffDetails = {}): string {
  const lines = summary.split("\n");
  const header = lines.slice(0, 5).map((line) => line.slice(0, 500));
  const recoverableLine = lines.find((line) => line.startsWith("  recoverable:"));
  const recoverable = recoverableLine ? [boundedRecoverableLine(recoverableLine)] : [];
  const progress = lines.filter((line) => /^  (live|dream) \d+: (running|interrupted)/.test(line));
  const active = lines.find((line) => line.startsWith("  in flight:"));
  const session = lines.filter((line) => line.startsWith("  session iteration:")).slice(0, 1);
  const worldsLine = lines.find((line) => line.startsWith("  worlds:"));
  const worlds = worldsLine?.replace(/ \(t=[^)]*\)/, "");
  const allRecords = lines.filter((line) => /^    t=\d+:/.test(line));
  const records = allRecords.slice(-3);
  const omitted = Math.max(0, allRecords.length - records.length);
  let action: string;
  if (details.kind === "active") action = "inspect or wait for the active owner; do not start duplicate work";
  else if (details.kind === "recoverable") action = "review the interrupted checkpoint and resume only when the user requests continuation";
  else action = "review status before starting a live or dream phase";
  const nextAction = `  next safe action: ${action}`;
  const selected = [
    ...header,
    ...recoverable,
    ...progress.slice(0, HANDOFF_MAX_RUN_ENTRIES),
    ...(active ? [active] : []),
    ...(details.iteration ? [`  selected iteration: ${details.iteration} (${details.kind ?? "recovery"})`] : []),
    ...(details.owner ? [`  owner: iteration ${details.iteration ?? "unknown"}, ${details.owner}`] : []),
    ...(details.checkpoint ? [`  checkpoint: iteration ${details.iteration ?? "unknown"}, ${details.checkpoint}`] : []),
    ...(worlds ? [worlds] : []),
    ...session,
    ...(omitted ? [`  recent history: showing newest 3 of ${omitted + records.length} recorded iterations`] : []),
    ...records,
  ];
  const bounded = selected.map((line) => line.slice(0, 700));
  let output = "";
  for (const line of bounded) {
    const candidate = output ? `${output}\n${line}` : line;
    if (candidate.length + nextAction.length + 1 > HANDOFF_MAX_CHARS) break;
    output = candidate;
  }
  if (output.length === 0) return "Dream-RSI status unavailable; inspect dream_rsi_status before continuing.";
  return `${output}\n${nextAction}`;
}

function boundedRecoverableLine(line: string): string {
  const match = /^  recoverable:\s*([\d, ]+)(.*)$/.exec(line);
  if (!match) return line.slice(0, 700);
  const iterations = match[1].split(",").map((value) => value.trim()).filter(Boolean);
  const shown = iterations.slice(0, HANDOFF_MAX_RUN_ENTRIES).join(", ");
  const omitted = iterations.length - Math.min(iterations.length, HANDOFF_MAX_RUN_ENTRIES);
  return `  recoverable: ${shown}${omitted > 0 ? ` (+${omitted} more)` : ""}${match[2]}`;
}
