#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadFixtures, runTier2, summarizeRates } from "./tier2.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROMPT_FILES = ["discovery-agent.md", "policy-improvement.md", "adversarial-review.md"];

export function hashPrompts(packageRoot) {
  return Object.fromEntries(PROMPT_FILES.map((name) => {
    const file = path.join(packageRoot, "prompts", name);
    if (!fs.existsSync(file)) throw new Error(`required prompt file is missing: ${name}`);
    return [name, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")];
  }));
}

export function validatePromptScoreConfig(config, packageRoot = ROOT) {
  if (!config || typeof config !== "object") throw new Error("prompt scoring requires explicit .auto/prompts-config.json");
  if (typeof config.model !== "string" || !config.model.trim()) throw new Error("prompt scoring config requires a pinned model");
  if (!Number.isSafeInteger(config.total_agent_budget) || config.total_agent_budget < 1) throw new Error("prompt scoring config requires a positive total_agent_budget");
  if (typeof config.budget_file !== "string" || !path.isAbsolute(config.budget_file)) throw new Error("prompt scoring config requires an absolute durable budget_file");
  const baseline = config.baseline;
  for (const field of ["meanWinRate", "proposalRate", "editRate", "timeoutRate"]) {
    if (!Number.isFinite(baseline?.[field]) || baseline[field] < 0 || baseline[field] > 1) throw new Error(`prompt scoring baseline requires ${field} from 0 to 1`);
  }
  const expectedHashes = config.baselinePromptHashes ?? baseline.promptHashes;
  if (!expectedHashes || JSON.stringify(sortObject(expectedHashes)) !== JSON.stringify(sortObject(hashPrompts(packageRoot)))) {
    throw new Error("baseline prompt hashes do not match the protected baseline prompt files");
  }
  const fixtureRoot = config.fixtureRoot ? path.resolve(ROOT, config.fixtureRoot) : path.join(ROOT, "eval", "fixtures");
  const available = loadFixtures(fixtureRoot).map(({ name }) => name);
  const fixtures = config.fixtures ?? available;
  if (!Array.isArray(fixtures) || fixtures.length === 0 || fixtures.some((name) => typeof name !== "string" || !name.trim()) || new Set(fixtures).size !== fixtures.length) {
    throw new Error("prompt scoring config fixtures must be a non-empty list of unique names");
  }
  const unknownFixtures = fixtures.filter((name) => !available.includes(name));
  if (unknownFixtures.length) throw new Error(`prompt scoring config names unknown fixture(s): ${unknownFixtures.join(", ")}`);
  return { ...config, fixtureRoot, fixtures };
}

export function scorePromptCandidate(summary, baseline, attemptedBudget) {
  const campaigns = summary.campaigns ?? [];
  const totals = campaigns.reduce((total, entry) => {
    for (const key of ["trueWins", "falseApplies", "agentStarts", "proposals", "editCount", "timeouts"]) total[key] += Number(entry.controller?.[key] ?? 0);
    return total;
  }, { trueWins: 0, falseApplies: 0, agentStarts: 0, proposals: 0, editCount: 0, timeouts: 0 });
  const starts = totals.agentStarts;
  const rates = summary.rates ?? summarizeRates(campaigns);
  const exhausted = summary.budgetExhausted === true || (attemptedBudget >= 0 && totals.agentStarts > attemptedBudget);
  const sufficient = starts > 0 && campaigns.length > 0;
  const passed = sufficient && !exhausted && summary.inputIntegrity !== false && totals.falseApplies === 0 &&
    (baseline.meanWinRate === 0 ? rates.meanWinRate > 0 : rates.meanWinRate >= baseline.meanWinRate) && rates.proposalRate + 0.005 >= baseline.proposalRate &&
    rates.editRate + 0.005 >= baseline.editRate && rates.timeoutRate <= baseline.timeoutRate + 0.005;
  return { passed, score: totals.falseApplies ? 0 : rates.meanWinRate, rates, ...totals, exhausted };
}

function sortObject(value) { return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))); }

export async function runPromptScore(workspace, configPath = path.join(ROOT, ".auto", "prompts-config.json")) {
  const config = validatePromptScoreConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
  const candidateRoot = path.resolve(workspace);
  const candidateHashesBefore = hashPrompts(candidateRoot);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-prompt-score-"));
  try {
    const summary = await runTier2({ run: true, model: config.model, agentBudget: config.agent_budget_per_fixture ?? 12,
      evaluatorBudget: config.evaluator_budget_per_fixture ?? 40, globalAgentBudget: config.total_agent_budget,
      budgetFile: config.budget_file, output, packageRoot: candidateRoot, fixtureRoot: config.fixtureRoot,
      fixtures: config.fixtures,
      maxCycles: config.max_cycles ?? 1, minimumGain: config.minimum_gain ?? 0 });
    const candidateHashesAfter = hashPrompts(candidateRoot);
    const unchangedDuringRun = JSON.stringify(candidateHashesBefore) === JSON.stringify(candidateHashesAfter);
    const result = scorePromptCandidate(summary, config.baseline, config.total_agent_budget);
    return { ...result, valid: unchangedDuringRun && summary.inputIntegrity !== false && !result.exhausted && result.passed, model: config.model,
      candidatePromptHashes: candidateHashesAfter, baselinePromptHashes: config.baselinePromptHashes ?? config.baseline.promptHashes,
      summary };
  } finally { fs.rmSync(output, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const workspace = process.argv[2] ?? process.cwd();
    const result = await runPromptScore(workspace);
    const score = { ...result, valid: result.valid && result.passed, score: result.score,
      fail_class: result.valid && result.passed ? "ok" : "evaluation_failed", error: result.valid && result.passed ? null : "prompt candidate failed protected Tier2 checks" };
    fs.mkdirSync("eval", { recursive: true });
    fs.writeFileSync(path.resolve("eval/score.json"), `${JSON.stringify(score, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(score, null, 2)}\n`);
    if (!result.valid || !result.passed) process.exitCode = 1;
  } catch (error) {
    const score = { score: 0, valid: false, fail_class: "evaluation_failed", error: error instanceof Error ? error.message : String(error) };
    try { fs.mkdirSync("eval", { recursive: true }); fs.writeFileSync(path.resolve("eval/score.json"), `${JSON.stringify(score, null, 2)}\n`); } catch {}
    process.stderr.write(`${score.error}\n`); process.exitCode = 1;
  }
}
