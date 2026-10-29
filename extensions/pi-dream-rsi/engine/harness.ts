import * as fs from "node:fs";
import * as path from "node:path";

import { pathProtected } from "./scope.ts";
import type { RunContract } from "./intake.ts";

const HARNESS_ROOT = ".dream-rsi-harness";
const MAX_DETECT_FILES = 600;
export type HarnessLanguage = "python" | "node";

interface HarnessPlan {
  files: [string, string];
  argv: string[];
  gate: string;
}

function harnessPlan(language: HarnessLanguage, projectDir?: string): HarnessPlan {
  const measure = `${HARNESS_ROOT}/${language === "python" ? "measure.py" : "measure.mjs"}`;
  const check = `${HARNESS_ROOT}/${language === "python" ? "check.py" : "check.mjs"}`;
  let runtime = language === "python" ? (process.platform === "win32" ? "python" : "python3") : "node";
  if (language === "python" && projectDir) {
    for (const env of [".venv", "venv"]) {
      const candidate = path.join(projectDir, env, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
      try { if (fs.statSync(candidate).isFile()) { runtime = candidate; break; } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  let shellRuntime = runtime;
  if (path.isAbsolute(runtime)) {
    if (process.platform === "win32") {
      if (/[\r\n%!"]/.test(runtime)) throw new Error("project interpreter path cannot be safely quoted for the correctness gate");
      shellRuntime = `"${runtime}"`;
    } else shellRuntime = `'${runtime.replace(/'/g, "'\\''")}'`;
  }
  return { files: [measure, check], argv: [runtime, measure], gate: `${shellRuntime} ${check}` };
}

/**
 * Pick the language for an authored harness from the project's own sources.
 * A repository can hold both a Python package and a JS front end, so the
 * single-language manifest decides; mixed manifests use a bounded source count.
 */
export function detectHarnessLanguage(projectDir: string): HarnessLanguage {
  const has = (file: string): boolean => fs.existsSync(path.join(projectDir, file));
  const pythonManifest = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"].some(has);
  const nodeManifest = ["package.json", "deno.json", "bun.lockb", "bun.lock"].some(has);
  // A single manifest is the clearest signal: helper scripts in a project root must not
  // outvote the language its package declares.
  if (pythonManifest !== nodeManifest) return pythonManifest ? "python" : "node";
  const counts = { python: 0, node: 0 };
  const queue = [""];
  let inspected = 0;
  while (queue.length > 0 && inspected < MAX_DETECT_FILES) {
    const relative = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(projectDir, relative), { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++inspected > MAX_DETECT_FILES) break;
      if (entry.name.startsWith(".") || ["node_modules", "vendor", "venv", "__pycache__", "dist", "build", "target"].includes(entry.name)) continue;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (relative.split("/").length < 3) queue.push(next); continue; }
      if (entry.name.endsWith(".py")) counts.python += 1;
      else if (/\.(?:mjs|cjs|js|jsx|ts|tsx)$/.test(entry.name)) counts.node += 1;
    }
  }
  // Mixed manifests or none: the majority of source files decides; an exact tie stays node.
  return counts.python > counts.node ? "python" : "node";
}

/** Resolve the exact setup authorization before any loop state or agent is started. */
export function withMeasurementHarness(params: Record<string, any>, projectDir: string, saved?: RunContract): Record<string, any> {
  if (params.setup_harness !== undefined && typeof params.setup_harness !== "boolean") throw new Error("setup_harness must be a boolean");
  if (!params.setup_harness) return params;
  // Resolve omissions before adding setup files. Explicit empty arrays remain explicit.
  params = {
    ...params,
    focus: params.focus === undefined ? saved?.outcome.statement : params.focus,
    unit: params.unit === undefined ? saved?.outcome.unit : params.unit,
    higher_is_better: params.higher_is_better === undefined ? saved?.outcome.higherIsBetter : params.higher_is_better,
    scope_roots: params.scope_roots === undefined ? saved?.scope.roots : params.scope_roots,
    gates: params.gates === undefined ? saved?.preserved.gates : params.gates,
    protected_assets: params.protected_assets === undefined ? saved?.scope.protectedAssets : params.protected_assets,
  };
  if (params.evaluator !== undefined || params.evaluator_bootstrap !== undefined) throw new Error("cannot combine setup_harness with evaluator or evaluator_bootstrap; supply the existing evaluator directly instead");
  if (typeof params.focus !== "string" || !params.focus.trim()) throw new Error("setup_harness requires an explicit improvement goal in focus");
  if (typeof params.unit !== "string" || !params.unit.trim() || typeof params.higher_is_better !== "boolean") throw new Error("unit and higher_is_better are required for measurement harness setup; choose the metric before authoring its evaluator");
  for (const key of ["scope_roots", "protected_assets", "gates"]) {
    if (params[key] !== undefined && (!Array.isArray(params[key]) || params[key].some((entry: unknown) => typeof entry !== "string" || !entry.trim()))) throw new Error(`${key} must be an array of non-empty strings`);
  }
  if (params.harness_language !== undefined && params.harness_language !== "python" && params.harness_language !== "node") {
    throw new Error("harness_language must be python or node");
  }
  const language: HarnessLanguage = params.harness_language ?? detectHarnessLanguage(projectDir);
  const plan = harnessPlan(language, projectDir);
  if (fs.existsSync(path.join(projectDir, HARNESS_ROOT)) || danglingHarnessLink(projectDir)) throw new Error(`${HARNESS_ROOT} already exists; inspect it and supply its evaluator directly, or start without setup_harness to reuse an approved contract`);
  if (plan.files.some((file) => pathProtected(file, params.protected_assets ?? []))) throw new Error("measurement harness files are protected; choose evaluator_bootstrap with explicitly approved alternative paths");
  const roots: string[] = params.scope_roots?.length ? params.scope_roots : ["."];
  return {
    ...params,
    harness_language: language,
    // This option authorizes only the two setup files in addition to the requested implementation scope.
    scope_roots: [...new Set([...roots, HARNESS_ROOT])],
    evaluator: { argv: [...plan.argv], output: "stdout-json", inputs: [HARNESS_ROOT] },
    gates: [...new Set([...(params.gates ?? []), plan.gate])],
    evaluator_bootstrap: { authorized: true, paths: [...plan.files] },
  };
}

function danglingHarnessLink(projectDir: string): boolean {
  try { return fs.lstatSync(path.join(projectDir, HARNESS_ROOT)).isSymbolicLink(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Instructions for the agent that authors the harness; the language decides the file names. */
export function measurementHarnessInstructions(language: HarnessLanguage): string {
  const [measure, check] = harnessPlan(language).files;
  const run = language === "python" ? `python ${measure}` : `node ${measure}`;
  const imports = language === "python"
    ? "Import the project with `sys.path.insert(0, str(Path(__file__).resolve().parents[1] / \"src\"))` (or the directory the package actually lives in), or run the existing local project command through `subprocess`."
    : "Import the implementation with paths relative to the harness files, or run the existing local project command.";
  return [
    "Create a measurement harness for the approved goal before optimization begins.",
    `Write exactly two ${language === "python" ? "Python" : "Node"} files: ${measure} (evaluator) and ${check} (correctness check).`,
    "Read the measured implementation and existing tests. Use fixed, deterministic inputs and independently known expected results; label synthetic inputs as synthetic.",
    `${measure} must execute the actual project behavior and print exactly one JSON object: {"score": <finite number in the approved unit>, "valid": true}.`,
    "For timing metrics, measure the workload, not process setup, and take repeated samples with a median. For other metrics, compute the declared score from the actual results; never substitute runtime, source-text matches, or a constant score.",
    `${check} must exit nonzero on wrong results, missing workload, or broken implementation. Embed fixed fixtures and expected results in these two files. Keep existing correctness gates.`,
    imports,
    `Run ${run} before finishing and make sure it prints valid JSON. Use only installed tools and dependencies. Return a nonzero exit or an invalid verdict when the behavior cannot be measured.`,
    "The evaluator, fixtures, and correctness check will be pinned outside candidate edit scope. The host will check baseline stability, sensitivity, and whether broken code is rejected before admitting any experiments.",
    "If the requested outcome has no defensible executable measurement from the available project and known answers, fail with a specific explanation instead of fabricating an evaluator.",
  ].join("\n");
}
