#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadFixtures, selectFixtures, reserveAgentBudget } from "./tier2.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURES = path.join(HERE, "fixtures");
const DEFAULT_PACKAGE_ROOT = path.resolve(HERE, "..");
const READINESS = new Set(["ready", "needs_setup", "needs a baseline", "needs a clearer goal", "already satisfied", "no defensible measure"]);
const MAX_TEXT_BYTES = 50 * 1024;

export function parseAssessArgs(argv) {
  const options = { run: false, list: false, fixtures: null, model: null, globalAgentBudget: null, budgetFile: null, output: null };
  for (const arg of argv) {
    if (arg === "--run") options.run = true;
    else if (arg === "--list") options.list = true;
    else {
      const match = /^--([a-z-]+)=(.*)$/.exec(arg);
      if (!match) throw new Error(`unknown argument ${arg}`);
      if (match[1] === "model") options.model = match[2];
      else if (match[1] === "global-agent-budget") options.globalAgentBudget = Number(match[2]);
      else if (match[1] === "budget-file") options.budgetFile = match[2];
      else if (match[1] === "output") options.output = match[2];
      else if (match[1] === "fixtures") {
        options.fixtures = match[2].split(",").map((item) => item.trim());
        if (!options.fixtures.length || options.fixtures.some((item) => !item) || new Set(options.fixtures).size !== options.fixtures.length) {
          throw new Error("fixtures must be a comma-separated list of unique fixture names");
        }
      } else throw new Error(`unknown option --${match[1]}`);
    }
  }
  if (options.run) {
    if (!options.model) throw new Error("real assessment runs require --model=<provider/model>");
    if (!Number.isSafeInteger(options.globalAgentBudget) || options.globalAgentBudget < 1) throw new Error("real assessment runs require --global-agent-budget=N");
    if (!options.budgetFile) throw new Error("real assessment runs require --budget-file=<shared durable counter>");
    if (!options.output) throw new Error("real assessment runs require --output=<new or empty directory>");
  }
  return options;
}

function safeWorkspaceCopy(source, destination, maxBytes = 5 * 1024 * 1024) {
  let total = 0;
  const copyDirectory = (from, to) => {
    fs.mkdirSync(to, { recursive: true, mode: 0o755 });
    for (const entry of fs.readdirSync(from, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      const stat = fs.lstatSync(src);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) copyDirectory(src, dst);
      else if (stat.isFile()) {
        total += stat.size;
        if (total > maxBytes) throw new Error("fixture source workspace exceeds the 5 MiB assessment copy limit");
        fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(dst, 0o444);
      }
    }
  };
  copyDirectory(source, destination);
  const makeReadOnly = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) makeReadOnly(item);
      else if (entry.isFile()) fs.chmodSync(item, 0o444);
    }
    fs.chmodSync(directory, 0o555);
  };
  makeReadOnly(destination);
  return total;
}

function removeAssessmentTree(root) {
  const makeWritable = (directory) => {
    if (!fs.existsSync(directory)) return;
    fs.chmodSync(directory, 0o755);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) makeWritable(item);
      else if (entry.isFile()) fs.chmodSync(item, 0o644);
    }
  };
  makeWritable(root);
  fs.rmSync(root, { recursive: true, force: true });
}

function textTail(current, value) {
  const combined = current + value;
  const bytes = Buffer.from(combined, "utf8");
  if (bytes.length <= MAX_TEXT_BYTES) return combined;
  let tail = bytes.subarray(bytes.length - MAX_TEXT_BYTES).toString("utf8");
  while (tail.length && (tail.charCodeAt(0) & 0xfc00) === 0xdc00) tail = tail.slice(1);
  return tail;
}

function parseJsonResponse(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(trimmed); } catch { /* allow ordinary preamble around one JSON value */ }
  const start = trimmed.indexOf("{");
  if (start < 0) return null;
  let depth = 0; let quoted = false; let escaped = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) {
      try { return JSON.parse(trimmed.slice(start, index + 1)); } catch { return null; }
    }
  }
  return null;
}

function isSafeRelativeFile(value) {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value)) return false;
  const normalized = value.replaceAll("\\", "/");
  return !normalized.split("/").some((part) => part === ".." || part === "." || part === "") && !normalized.includes(":");
}

function normalizeReadiness(value) {
  const lower = value.toLowerCase().trim().replaceAll("-", "_");
  if (/^needs(?:_| )a?(?:_| )baseline$/.test(lower)) return "needs_setup";
  return lower;
}

function acceptedReadiness(value) {
  const normalized = normalizeReadiness(value);
  return ["ready", "needs_setup", "needs a clearer goal", "already satisfied", "no defensible measure"].includes(normalized);
}

function metricTokens(value) {
  return new Set(value.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/milliseconds?|\bms\b/g, "ms")
    .replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter((token) => token && !["a", "the", "of", "in", "per", "is", "better"].includes(token)));
}

function metricMatches(candidate, target) {
  const left = metricTokens(candidate); const right = metricTokens(target);
  if (!left.size || !right.size) return false;
  const overlap = [...left].filter((word) => right.has(word)).length;
  return overlap / Math.max(left.size, right.size) >= 0.65;
}

function directionMatches(text, direction) {
  const value = text.toLowerCase();
  const positive = direction === "maximize";
  return positive ? /\b(?:higher|more|increase|maximize|maximum|larger|faster)\b/.test(value)
    : /\b(?:lower|less|fewer|reduce|minimi[sz]e|minimum|smaller|faster)\b/.test(value);
}

function evaluatorMatches(value, manifest) {
  void manifest;
  return value.trim().toLowerCase() === "command";
}

function structurallyValid(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.levers) || value.levers.length > 3) return false;
  return value.levers.every((lever) => lever && typeof lever === "object" && !Array.isArray(lever)
    && typeof lever.goal === "string" && lever.goal.trim().length > 0 && lever.goal.length <= 500
    && Array.isArray(lever.scope_files) && lever.scope_files.length > 0 && lever.scope_files.length <= 8
    && lever.scope_files.every(isSafeRelativeFile) && typeof lever.metric === "string" && lever.metric.trim().length > 0 && lever.metric.length <= 300
    && typeof lever.evaluator_kind === "string" && lever.evaluator_kind.length <= 100
    && typeof lever.readiness === "string" && READINESS.has(lever.readiness.toLowerCase()) && acceptedReadiness(lever.readiness));
}

export function gradeAssessment(response, manifest) {
  const valid = structurallyValid(response);
  if (!valid) return {
    structurallyValid: false, validLeverCount: 0,
    top3Hits: { scope: false, metricLexical: false, direction: false, evaluatorKind: false, evaluatorReadiness: false, completeStructural: false },
    perLever: [], evaluatorReadinessTarget: "needs_setup", metricMatchMethod: "lexical token overlap heuristic; not semantic evaluation",
    semanticGoalCorrectness: "not_automatically_judged",
  };
  const levers = response.levers.slice(0, 3);
  const expectedScope = new Set(manifest.scope_files.map((file) => file.replaceAll("\\", "/")));
  // Evaluator definitions live outside the source-only copy, so the assessment agent
  // cannot inspect or verify them and must report setup as still required.
  const expectedReadiness = manifest.evaluator && manifest.gate ? "needs_setup" : "no defensible measure";
  const graded = levers.map((lever) => {
    const scopeHit = lever.scope_files.some((file) => expectedScope.has(file.replaceAll("\\", "/")));
    return {
      scopeHit,
      metricHit: typeof lever.metric === "string" && metricMatches(lever.metric, manifest.metric),
      directionHit: typeof lever.metric === "string" && directionMatches(lever.metric, manifest.direction),
      evaluatorKindHit: typeof lever.evaluator_kind === "string" && evaluatorMatches(lever.evaluator_kind, manifest),
      readinessHit: typeof lever.readiness === "string" && normalizeReadiness(lever.readiness) === expectedReadiness,
    };
  });
  const hit = (key) => graded.some((row) => row[key]);
  const completeStructural = graded.some((row) => row.scopeHit && row.metricHit && row.directionHit && row.evaluatorKindHit && row.readinessHit);
  return {
    structurallyValid: valid,
    validLeverCount: valid ? levers.length : 0,
    top3Hits: { scope: hit("scopeHit"), metricLexical: hit("metricHit"), direction: hit("directionHit"), evaluatorKind: hit("evaluatorKindHit"), evaluatorReadiness: hit("readinessHit"), completeStructural },
    perLever: graded,
    evaluatorReadinessTarget: expectedReadiness,
    metricMatchMethod: "lexical token overlap heuristic; not semantic evaluation",
    semanticGoalCorrectness: "not_automatically_judged",
  };
}

function promptForAssessment(skill, signals) {
  return `You are performing a read-only assessment of the files in the current workspace. Use only the read, grep, find, and ls tools. Never run commands, invoke agents, modify files, or inspect anything outside this copied workspace. Evaluator, gate, and baseline definitions are unavailable; infer readiness from the available evidence and the reference skill. Inspect relevant source and tests directly. Return no prose: output exactly one JSON object with this shape: {"levers":[{"goal":"...","scope_files":["workspace-relative path"],"metric":"measurable metric with units and higher/lower-is-better direction","evaluator_kind":"command","readiness":"ready, needs_setup, needs a clearer goal, already satisfied, or no defensible measure"}]}. Return at most three distinct levers. Do not invent effect sizes or claim an evaluator was run. The grader checks only structure, scope, metric, direction, evaluator kind, and readiness; it does not automatically judge whether your goal is semantically correct.

Production project signals, reduced to safe categories and counts: ${JSON.stringify(signals)}

Reference assessment skill (follow its read-only and evidence standards, but obey the JSON-only output contract above):
<skill>
${skill}
</skill>`;
}

function outputPathFor(options) {
  const output = path.resolve(options.output);
  if (fs.existsSync(output) && fs.readdirSync(output).length > 0) throw new Error(`output directory must be new or empty: ${output}`);
  fs.mkdirSync(output, { recursive: true });
  return output;
}

export async function runAssessment(options) {
  if (!options?.run) throw new Error("assessment is inert unless --run is supplied");
  if (!options.model || !Number.isSafeInteger(options.globalAgentBudget) || options.globalAgentBudget < 1 || !options.budgetFile || !options.output) {
    throw new Error("assessment requires --model, --global-agent-budget, --budget-file, and --output");
  }
  const packageRoot = path.resolve(options.packageRoot ?? DEFAULT_PACKAGE_ROOT);
  const fixtureRoot = path.resolve(options.fixtureRoot ?? DEFAULT_FIXTURES);
  const fixtures = selectFixtures(loadFixtures(fixtureRoot), options.fixtures);
  if (options.globalAgentBudget < fixtures.length) throw new Error("global agent budget must cover one assessment run per selected fixture");
  const outputRoot = outputPathFor(options);
  const budgetFile = path.resolve(options.budgetFile);
  const budgetState = fs.existsSync(budgetFile) ? JSON.parse(fs.readFileSync(budgetFile, "utf8")) : { version: 1, limit: options.globalAgentBudget, spent: 0 };
  if (budgetState.version !== 1 || budgetState.limit !== options.globalAgentBudget || !Number.isSafeInteger(budgetState.spent) || budgetState.spent < 0) {
    throw new Error("global agent budget file does not match configured immutable limit");
  }
  if (budgetState.spent + fixtures.length > options.globalAgentBudget) throw new Error("global agent budget does not have enough remaining starts for all selected fixtures");

  const skill = fs.readFileSync(path.join(packageRoot, "skills", "dream-rsi-assess", "SKILL.md"), "utf8");
  const { runAgent: productionRunAgent } = await import(pathToFileURL(path.join(packageRoot, "extensions", "pi-dream-rsi", "agent", "runner.ts")).href);
  const runAgent = options.runAgentImpl ?? productionRunAgent;
  const { collectSignals } = await import(pathToFileURL(path.join(packageRoot, "extensions", "pi-dream-rsi", "engine", "signals.ts")).href);
  const assessments = [];
  for (const { name, root, manifest } of fixtures) {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-assess-"));
    const workspace = path.join(temporaryRoot, "workspace");
    try {
      safeWorkspaceCopy(path.join(root, manifest.workspace), workspace);
      const signalResult = await collectSignals({ projectDir: workspace, includeLogs: false, now: new Date() });
      const safeSignals = signalResult.weaknesses.map((item) => ({ kind: item.kind, count: item.evidence.reduce((sum, fact) => sum + fact.count, 0) }));
      let text = "";
      const run = await runAgent({
        agent: { command: "pi", args: ["-p", "--mode", "json", "--no-session", "-na", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--tools", "read,grep,find,ls"], model: options.model, thinking: "minimal", prompt_via: "stdin", output_format: "pi-json" },
        cwd: workspace,
        prompt: promptForAssessment(skill, safeSignals),
        timeoutMs: 8 * 60_000,
        beforeSpawn: () => reserveAgentBudget(budgetFile, options.globalAgentBudget),
        onOutput: (event) => { if (event.kind === "text" && event.stream === "stdout") text = textTail(text, event.text); },
      });
      const parsed = parseJsonResponse(text);
      const grade = gradeAssessment(parsed, manifest);
      assessments.push({ fixture: name, model: options.model, processOk: run.ok, timedOut: run.timedOut, spawnFailed: Boolean(run.spawnError), outputParsed: parsed !== null,
        usage: run.evidence?.usage ?? null, stopReasons: run.evidence?.stopReasons ?? {}, durationMs: run.durationMs,
        grade, response: grade.structurallyValid ? parsed : null });
    } finally { removeAssessmentTree(temporaryRoot); }
  }
  const facets = ["scope", "metricLexical", "direction", "evaluatorKind", "evaluatorReadiness", "completeStructural"];
  const report = { version: 1, model: options.model, selectedFixtures: fixtures.map(({ name }) => name), runCount: assessments.length,
    sharedBudgetFile: budgetFile, assessments, top3HitRates: Object.fromEntries(facets.map((key) => [key,
      assessments.length ? assessments.filter((item) => item.grade.top3Hits[key]).length / assessments.length : 0])),
    metricMatchMethod: "lexical token overlap heuristic; not semantic evaluation",
    semanticGoalCorrectness: "not_automatically_judged", generatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(outputRoot, "assessment.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return report;
}

async function main(argv) {
  const options = parseAssessArgs(argv);
  if (options.list) {
    const names = loadFixtures().map(({ name }) => name);
    process.stdout.write(`${JSON.stringify({ fixtures: names }, null, 2)}\n`);
    return;
  }
  if (!options.run) {
    process.stdout.write("Assessment is read-only and inert by default; no model calls were made. Use --list to inspect fixture names. For a real run, pass --run, --model, --global-agent-budget, --budget-file, and --output.\n");
    return;
  }
  const report = await runAssessment(options);
  process.stdout.write(`${JSON.stringify({ output: path.resolve(options.output), model: report.model, runCount: report.runCount, top3HitRates: report.top3HitRates }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
