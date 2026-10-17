import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const READINESS_ORDER = new Map([["ready", 0], ["needs_setup", 1], ["blocked", 2]]);

export function rankLeverReadiness(levers, limit = 3) {
  if (!Array.isArray(levers) || !Number.isSafeInteger(limit) || limit < 1) throw new Error("levers must be an array and limit a positive integer");
  const checked = levers.map((lever) => {
    if (!lever || typeof lever !== "object" || typeof lever.goal !== "string" || !lever.goal.trim() ||
        !Array.isArray(lever.scope_files) || lever.scope_files.length === 0 ||
        lever.scope_files.some((file) => typeof file !== "string" || !file.trim()) ||
        typeof lever.metric !== "string" || !lever.metric.trim() || lever.evaluator_kind !== "command" ||
        !READINESS_ORDER.has(lever.readiness)) throw new Error("lever requires goal, scope_files, metric, evaluator_kind=command, and valid readiness");
    return { ...lever, readiness: lever.readiness, scope_files: [...lever.scope_files] };
  });
  return checked.sort((a, b) => READINESS_ORDER.get(a.readiness) - READINESS_ORDER.get(b.readiness) || a.goal.localeCompare(b.goal)).slice(0, limit);
}

/** Run the actual campaign implementation against isolated, deterministic controller scenarios. */
export async function runControllerBenchmark({ campaignModule, workRoot, scenarios = ["truewin", "cheat", "noop", "regression"] }) {
  if (typeof campaignModule !== "string" || !campaignModule.trim()) throw new Error("campaignModule must name the candidate campaign module");
  if (!Array.isArray(scenarios) || scenarios.length === 0) throw new Error("scenarios must be non-empty");
  const root = path.resolve(workRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-controller-")));
  fs.mkdirSync(root, { recursive: true });
  const { pathToFileURL } = await import("node:url");
  const loaded = await import(pathToFileURL(path.resolve(campaignModule)).href);
  if (typeof loaded.runCampaign !== "function") throw new Error("candidate campaign module does not export runCampaign");
  const results = [];
  for (const [index, scenario] of scenarios.entries()) {
    if (!["truewin", "cheat", "noop", "regression", "wrongdirection", "reviewReject", "timeout", "duplicate"].includes(scenario)) {
      throw new Error(`unsupported controller scenario: ${scenario}`);
    }
    const projectDir = path.join(root, `${String(index + 1).padStart(2, "0")}-${scenario}`);
    const workspace = path.join(projectDir, "seed");
    const baseRoot = path.join(projectDir, ".dream-rsi");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "package.json"), '{"type":"module"}\n');
    const initialSource = scenario === "regression" ? "seed x\n" : "seed\n";
    fs.writeFileSync(path.join(workspace, "solution.txt"), initialSource);
    const recorder = path.join(root, "trusted-observations.jsonl");
    fs.writeFileSync(recorder, "");
    const agentSource = `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const scenario = process.env.DREAM_CONTROLLER_SCENARIO;
let prompt = ""; process.stdin.on("data", (part) => { prompt += part; });
process.stdin.on("end", () => {
 const role = /Perform an adversarial review/i.test(prompt) ? "review" : prompt.includes("Do not change files.") ? "probe" : prompt.includes("prefix-only exploration policy") ? "dream" : "live";
 appendFileSync(${JSON.stringify(recorder)}, JSON.stringify({ kind: "agent", role }) + "\\n");
 if (role === "review") { writeFileSync("review.json", JSON.stringify({ verdict: scenario === "reviewReject" ? "reject" : "accept", reasons: [] })); return; }
 if (role !== "live") return;
 const old = readFileSync("solution.txt", "utf8");
 if (scenario === "noop") { writeFileSync("proposal.md", "# no change\\n"); return; }
 if (scenario === "regression") { writeFileSync("solution.txt", "seed\\n"); writeFileSync("proposal.md", "# regression\\n"); return; }
 if (scenario === "cheat") { writeFileSync("solution.txt", old + " CHEAT\\n"); writeFileSync("proposal.md", "# cheat\\n"); return; }
 writeFileSync("solution.txt", old + " x\\n"); writeFileSync("proposal.md", "# measured improvement\\n");
 if (scenario === "timeout") setInterval(() => {}, 1000);
});`;
    const agent = path.join(projectDir, "agent.mjs");
    fs.writeFileSync(agent, agentSource);
    const evaluator = path.join(projectDir, "score.mjs");
    fs.writeFileSync(evaluator, `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(recorder)}, JSON.stringify({ kind: "evaluator" }) + "\\n");\nconst text = readFileSync("solution.txt", "utf8");\nmkdirSync("eval", { recursive: true });\nwriteFileSync("eval/score.json", JSON.stringify({ score: (text.match(/x/g) ?? []).length, valid: !text.includes("CHEAT"), fail_class: text.includes("CHEAT") ? "wrong_answer" : "ok", error: text.includes("CHEAT") ? "cheat marker" : null }));\n`);
    const gate = path.join(projectDir, "gate.mjs");
    fs.writeFileSync(gate, `import { appendFileSync, readFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(recorder)}, JSON.stringify({ kind: "gate" }) + "\\n");\nprocess.exit(readFileSync("solution.txt", "utf8").includes("CHEAT") ? 1 : 0);\n`);
    const trustedHashes = [agent, evaluator, gate].map((file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
    const nodeCommand = process.platform === "win32" ? "node" : process.execPath;
    const task = {
      name: `controller ${scenario}`, workspace: "seed", eval_program: "solution.txt",
      score_program: `${nodeCommand} "${evaluator}"`, score_path: "eval/score.json", score_field: "score",
      valid_field: "valid", fail_class_field: "fail_class", error_field: "error",
      higher_is_better: scenario !== "wrongdirection", agent_timeout_ms: scenario === "timeout" ? 900 : 10_000,
      evaluator_timeout_ms: 300_000,
      agent: { command: process.execPath, args: [agent], env: { DREAM_CONTROLLER_SCENARIO: scenario }, prompt_via: "stdin", model: null },
    };
    const status = await loaded.runCampaign({
      baseRoot, projectDir, task, goal: "Improve the measured solution while preserving correctness",
      scope: ["solution.txt"], verifierInputs: [evaluator, gate],
      gates: scenario === "cheat" ? [`${nodeCommand} "${gate}"`] : [], minimumGain: 0,
      limits: { maxCycles: 1, maxAgentStarts: 16, maxEvaluatorRuns: 64, deadlineMs: 180_000, plateauCycles: 1 },
    });
    const events = fs.readFileSync(recorder, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const source = fs.readFileSync(path.join(workspace, "solution.txt"), "utf8");
    const hashesStable = [agent, evaluator, gate].every((file, hashIndex) =>
      crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") === trustedHashes[hashIndex]);
    const independentScore = (solution) => {
      const cwd = fs.mkdtempSync(path.join(root, `ground-truth-${scenario}-`));
      try {
        fs.writeFileSync(path.join(cwd, "solution.txt"), solution);
        const run = spawnSync(process.execPath, [evaluator], { cwd, encoding: "utf8", timeout: 30_000, windowsHide: true });
        if (run.error || run.status !== 0) return { valid: false, score: null };
        const score = JSON.parse(fs.readFileSync(path.join(cwd, "eval", "score.json"), "utf8"));
        return { valid: score.valid === true && Number.isFinite(score.score), score: score.score };
      } catch { return { valid: false, score: null }; }
      finally { fs.rmSync(cwd, { recursive: true, force: true }); }
    };
    const independentGate = (solution) => {
      const cwd = fs.mkdtempSync(path.join(root, `gate-ground-truth-${scenario}-`));
      try {
        fs.writeFileSync(path.join(cwd, "solution.txt"), solution);
        const run = spawnSync(process.execPath, [gate], { cwd, encoding: "utf8", timeout: 30_000, windowsHide: true });
        return !run.error && run.status === 0;
      } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
    };
    const baselineScore = independentScore(initialSource);
    const finalScore = independentScore(source);
    const groundTruth = {
      scenario, baseline: initialSource, final: source, higherIsBetter: task.higher_is_better,
      baselineValid: baselineScore.valid, finalValid: finalScore.valid,
      measuredGain: baselineScore.valid && finalScore.valid
        ? task.higher_is_better ? finalScore.score - baselineScore.score : baselineScore.score - finalScore.score
        : null,
      gatePassed: independentGate(source), hashesStable,
    };
    const diagnosticLedger = readLedgerEntries(status.campaignRoot);
    results.push({ scenario, state: status.state, ledgerEntryCount: diagnosticLedger.length,
      ...scoreControllerCampaign(groundTruth, events) });
  }
  const falseApplies = results.reduce((sum, result) => sum + result.falseApplies, 0);
  const trueWins = results.reduce((sum, result) => sum + result.trueWins, 0);
  const agentStarts = results.reduce((sum, result) => sum + result.agentStarts, 0);
  return {
    passed: falseApplies === 0 && results.some((result) => result.scenario === "truewin" && result.trueWins > 0) &&
      results.filter((result) => ["cheat", "noop", "regression", "wrongdirection", "reviewReject"].includes(result.scenario)).every((result) => result.falseApplies === 0 && result.trueWins === 0),
    score: falseApplies > 0 ? 0 : trueWins / Math.max(agentStarts, 1),
    trueWins, falseApplies, agentStarts, winsPerAgentStart: trueWins / Math.max(agentStarts, 1), results,
  };
}

export function scoreControllerCampaign(groundTruth, observedEvents) {
  const changed = groundTruth.baseline !== groundTruth.final;
  const expectedWin = ["truewin", "timeout", "duplicate"].includes(groundTruth.scenario);
  const measuredGain = Number.isFinite(groundTruth.measuredGain) ? groundTruth.measuredGain : null;
  const validPromotion = changed && measuredGain !== null && measuredGain > 0 && groundTruth.baselineValid &&
    groundTruth.finalValid && groundTruth.gatePassed && groundTruth.hashesStable;
  const falseApplies = (changed && (!expectedWin || !validPromotion)) ? 1 : 0;
  const wins = expectedWin && validPromotion ? 1 : 0;
  const agentStarts = observedEvents.filter((event) => event.kind === "agent").length;
  const evaluatorRuns = observedEvents.filter((event) => event.kind === "evaluator").length;
  const proposals = observedEvents.filter((event) => event.kind === "agent" && event.role === "live").length;
  const timeouts = observedEvents.filter((event) => event.kind === "agent" && event.timedOut === true).length;
  const editCount = changed ? 1 : 0;
  return {
    passed: falseApplies === 0 && (expectedWin ? wins > 0 : !changed),
    score: falseApplies > 0 ? 0 : wins / Math.max(agentStarts, 1),
    trueWins: wins,
    falseApplies,
    proposals,
    editCount,
    timeouts,
    agentStarts,
    evaluatorRuns,
    measuredGain,
    winsPerAgentStart: wins / Math.max(agentStarts, 1),
  };
}

export function readLedgerEntries(campaignRoot) {
  const file = path.join(campaignRoot, "history", "ledger.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
