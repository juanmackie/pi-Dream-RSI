/** Presentation-only decoding; structural telemetry never retains tool arguments or file paths. */
import * as path from "node:path";
export interface OutputEvent {
  stream: "stdout" | "stderr";
  kind: "text" | "tool-start" | "tool-update" | "tool-end" | "usage";
  text: string;
  toolId?: string;
  toolName?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  model?: string;
  stopReason?: string;
  edit?: boolean;
  read?: boolean;
  verifierRead?: boolean;
}

export interface AgentOutputEvidence {
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  stopReasons: Record<string, number>;
  modelChanges: number;
  editCount: number;
  verifierRead: boolean;
}

export class BoundedTail {
  text = "";
  append(text: string): void {
    this.text = (this.text + text).slice(-64 * 1024).split("\n").slice(-200).join("\n");
    while (new TextEncoder().encode(this.text).byteLength > 64 * 1024) this.text = this.text.slice(1024);
  }
}

/** Incremental JSONL decoder, with a bounded raw fallback for malformed/oversized lines. */
export class OutputDecoder {
  private pending = "";
  private discardingLine = false;
  private json: boolean;
  private emit: (event: OutputEvent) => void;
  private protectedPaths: Set<string>;
  private cwd: string;
  constructor(json: boolean, emit: (event: OutputEvent) => void, options: { protectedReadPaths?: string[]; cwd?: string } = {}) {
    this.json = json;
    this.emit = emit;
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.protectedPaths = new Set((options.protectedReadPaths ?? []).map((file) => this.normalizePath(file)));
  }
  private normalizePath(file: string): string {
    const absolute = path.resolve(this.cwd, file);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  }
  feed(stream: "stdout" | "stderr", text: string): void {
    if (!this.json || stream === "stderr") { this.emit({ stream, kind: "text", text }); return; }
    this.pending += text;
    let end: number;
    if (this.discardingLine) {
      end = this.pending.indexOf("\n");
      if (end < 0) { this.pending = ""; return; }
      this.pending = this.pending.slice(end + 1);
      this.discardingLine = false;
    }
    while ((end = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, end);
      if (line.length > 64 * 1024) this.emit({ stream, kind: "text", text: "[oversized pi JSON line omitted]" });
      else this.line(line);
      this.pending = this.pending.slice(end + 1);
    }
    if (this.pending.length > 64 * 1024) {
      this.emit({ stream, kind: "text", text: "[oversized pi JSON line omitted]" });
      this.pending = "";
      this.discardingLine = true;
    }
  }
  finish(): void { if (this.pending && !this.discardingLine) this.line(this.pending); this.pending = ""; this.discardingLine = false; }
  private line(line: string): void {
    if (!line.trim()) return;
    try {
      const value = JSON.parse(line);
      const event = value.assistantMessageEvent;
      if (value.type === "message_end" || value.type === "agent_end") {
        const message = value.message ?? value;
        const rawUsage = message.usage;
        if (rawUsage && typeof rawUsage === "object") {
          const usage = rawUsage as Record<string, unknown>;
          const number = (...keys: string[]): number | undefined => {
            for (const key of keys) if (typeof usage[key] === "number" && Number.isFinite(usage[key])) return Math.max(0, usage[key] as number);
            return undefined;
          };
          this.emit({ stream: "stdout", kind: "usage", text: "usage", usage: {
            input: number("input", "inputTokens"), output: number("output", "outputTokens"),
            cacheRead: number("cacheRead", "cache_read_input_tokens"), cacheWrite: number("cacheWrite", "cache_creation_input_tokens"),
            total: number("totalTokens", "total"),
          }, model: typeof message.model === "string" ? message.model : undefined,
            stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined });
        } else {
          this.emit({ stream: "stdout", kind: "usage", text: "message end",
            model: typeof message.model === "string" ? message.model : undefined,
            stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined });
        }
      }
      if (value.type === "message_update" && event?.type === "text_delta") {
        this.emit({ stream: "stdout", kind: "text", text: String(event.delta ?? "") });
      } else if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(value.type)) {
        const kind = value.type === "tool_execution_start" ? "tool-start" : value.type === "tool_execution_end" ? "tool-end" : "tool-update";
        const content = value.partialResult ?? value.result ?? value.args ?? "";
        const toolName = typeof value.toolName === "string" ? value.toolName : undefined;
        const normalized = toolName?.toLowerCase() ?? "";
        const args = value.args && typeof value.args === "object" ? value.args as Record<string, unknown> : {};
        const readPath = [args.path, args.filePath, args.file_path].find((item): item is string => typeof item === "string");
        const verifierRead = kind === "tool-start" && /^(read|cat|open|grep|rg)$/.test(normalized)
          && readPath !== undefined && this.protectedPaths.has(this.normalizePath(readPath));
        this.emit({ stream: "stdout", kind, toolId: value.toolCallId, toolName,
          text: typeof content === "string" ? content : "tool activity",
          edit: kind === "tool-start" && /^(edit|write|apply_patch)$/.test(normalized),
          read: kind === "tool-start" && /^(read|cat|open|grep|rg)$/.test(normalized), verifierRead });
      }
    } catch {
      this.emit({ stream: "stdout", kind: "text", text: /^\s*[\[{]/.test(line) ? "[malformed pi JSON event omitted]\n" : line + "\n" });
    }
  }
}
