import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DashboardView } from "../extensions/pi-dream-rsi/dashboard.ts";
import { ProgressRecorder } from "../extensions/pi-dream-rsi/engine/progress.ts";

const audit = path.dirname(fileURLToPath(import.meta.url));
const sdkRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const { loadThemeFromPath } = await import(pathToFileURL(path.join(sdkRoot, "dist/modes/interactive/theme/theme.js")).href);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-dashboard-preview-"));
const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function htmlAnsi(text, defaultFg, defaultBg) {
  let fg = defaultFg;
  let bg = defaultBg;
  let bold = false;
  let position = 0;
  let html = "";
  const append = (part) => {
    if (part) html += `<span style="color:${fg};background:${bg};font-weight:${bold ? 700 : 400}">${escape(part)}</span>`;
  };
  for (const match of text.matchAll(/\x1b\[([\d;]*)m/g)) {
    append(text.slice(position, match.index));
    position = match.index + match[0].length;
    const codes = (match[1] || "0").split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) { fg = defaultFg; bg = defaultBg; bold = false; }
      else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) fg = defaultFg;
      else if (code === 49) bg = defaultBg;
      else if ((code === 38 || code === 48) && codes[i + 1] === 2) {
        const color = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
        if (code === 38) fg = color; else bg = color;
        i += 4;
      }
    }
  }
  append(text.slice(position));
  return html;
}

try {
  fs.writeFileSync(path.join(root, "campaign.json"), JSON.stringify({ id: "12345678-preview", limits: { maxCycles: 5 }, state: { kind: "running", phase: "promote", iteration: 2 }, completedCycles: [1] }));
  const recorder = new ProgressRecorder(root, 2, "live", 3, 2);
  recorder.stage("b0a0", "root", 1, "failed", 0, null, "candidate rejected by the correctness gate");
  recorder.stage("b1a0", "root", 1, "evaluation", 0, 12);
  recorder.stage("b2a0", "root", 1, "complete", 0, 15);
  recorder.snapshot.attempts.b0a0.agent_tail = "Inspecting parser loop\nRemoving repeated allocation\nCandidate score: 15\nCorrectness gate failed: empty input\nReview pending";
  recorder.activity("Checking a measured improvement before applying it");
  fs.mkdirSync(path.join(root, "history"), { recursive: true });
  fs.writeFileSync(path.join(root, "history/rejections.jsonl"), JSON.stringify({ iteration: 2, cell: "b0a0", stage: "gate", reasons: ["Empty input regression in the parser test suite"] }) + "\n");
  const view = new DashboardView(root, 2);
  view.pane = 1;
  for (const name of ["dark", "light"]) {
    const theme = loadThemeFromPath(path.join(sdkRoot, `dist/modes/interactive/theme/${name}.json`), "truecolor");
    const rows = view.framed(80, theme, 27);
    const defaultFg = name === "dark" ? "#d4d4d4" : "#202020";
    const defaultBg = name === "dark" ? "#171717" : "#ffffff";
    fs.writeFileSync(path.join(audit, `dashboard-${name}.ansi`), rows.join("\n"));
    fs.writeFileSync(path.join(audit, `dashboard-${name}.html`), `<!doctype html><meta charset="utf-8"><title>Dream-RSI ${name} preview</title><style>body{margin:0;padding:24px;background:${defaultBg};color:${defaultFg};font:16px Consolas,monospace}h1{font:16px system-ui;margin:0 0 18px}pre{display:inline-block;margin:0;font:14px/20px Consolas,monospace;white-space:pre}pre span{display:inline-block;height:20px;line-height:20px;vertical-align:top}p{font:12px system-ui;color:${name === "dark" ? "#aaa" : "#555"}}details{margin-top:24px}textarea{display:block;width:400px;height:60px}</style><h1>Dream-RSI /watch · ${name}</h1><pre>${rows.map((row) => htmlAnsi(row, defaultFg, defaultBg)).join("\n")}</pre><p>Exact DashboardView.framed output with the installed Pi ${name} theme and a seeded verification fixture.</p><details><summary>Save screenshot evidence</summary><label>Screenshot JPEG data<textarea id="capture"></textarea></label><button id="save">Save snapshot</button><output id="saved"></output></details><script>document.querySelector('#save').onclick=async()=>{const response=await fetch('/capture/${name}',{method:'POST',body:document.querySelector('#capture').value});document.querySelector('#saved').textContent=await response.text()};</script>`);
  }
  console.log("Rendered .audit/dashboard-dark.html and .audit/dashboard-light.html from actual framed output.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
