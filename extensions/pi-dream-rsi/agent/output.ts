/** Presentation-only decoding. Raw child output is always retained in its log. */
export interface OutputEvent {
  stream: "stdout" | "stderr";
  kind: "text" | "tool-start" | "tool-update" | "tool-end";
  text: string;
  toolId?: string;
  toolName?: string;
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
  private json: boolean;
  private emit: (event: OutputEvent) => void;
  constructor(json: boolean, emit: (event: OutputEvent) => void) { this.json = json; this.emit = emit; }
  feed(stream: "stdout" | "stderr", text: string): void {
    if (!this.json || stream === "stderr") { this.emit({ stream, kind: "text", text }); return; }
    this.pending += text;
    let end: number;
    while ((end = this.pending.indexOf("\n")) >= 0) {
      this.line(this.pending.slice(0, end));
      this.pending = this.pending.slice(end + 1);
    }
    if (this.pending.length > 64 * 1024) {
      this.emit({ stream, kind: "text", text: this.pending });
      this.pending = "";
    }
  }
  finish(): void { if (this.pending) this.line(this.pending); this.pending = ""; }
  private line(line: string): void {
    if (!line.trim()) return;
    try {
      const value = JSON.parse(line);
      const event = value.assistantMessageEvent;
      if (value.type === "message_update" && event?.type === "text_delta") {
        this.emit({ stream: "stdout", kind: "text", text: String(event.delta ?? "") });
      } else if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(value.type)) {
        const kind = value.type === "tool_execution_start" ? "tool-start" : value.type === "tool_execution_end" ? "tool-end" : "tool-update";
        const content = value.partialResult ?? value.result ?? value.args ?? "";
        this.emit({ stream: "stdout", kind, toolId: value.toolCallId, toolName: value.toolName,
          text: typeof content === "string" ? content : JSON.stringify(content) });
      }
    } catch { this.emit({ stream: "stdout", kind: "text", text: line + "\n" }); }
  }
}
