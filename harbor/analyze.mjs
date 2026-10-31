import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateEvidenceProtocol } from "./validate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const num = (value) => Number.isFinite(value) ? value : NaN;
const fail = (errors, text) => errors.push(text);
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const evidenceProtocol = JSON.parse(fs.readFileSync(path.join(here, "evidence-protocol.json"), "utf8"));

export function analyzePilot(data) {
  const errors = [];
  if (!data || data.schemaVersion !== 1 || data.study !== "dream-rsi-pilot" || !["observed", "fixture"].includes(data.source)) fail(errors, "input is not a v1 pilot result set with an explicit observed/fixture source");
  if (!Array.isArray(data?.repositories) || data.repositories.length !== 6) fail(errors, "pilot denominator must contain six repositories");
  const repos = Array.isArray(data?.repositories) ? data.repositories : [];
  const ids = new Set(); const languages = new Set(); let dev = 0; let held = 0; let trials = 0; let breadth = 0; let regressions = 0; let accepted = 0;
  for (const repo of repos) {
    if (!repo?.id || ids.has(repo.id)) fail(errors, "repository IDs must be present and unique"); else ids.add(repo.id);
    if (repo?.split === "development") dev++; else if (repo?.split === "held-out") held++; else fail(errors, "repository split is invalid");
    if (typeof repo?.language === "string" && repo.language.trim()) languages.add(repo.language); else fail(errors, `repository ${repo?.id ?? "?"} needs a language label`);
    if (!Array.isArray(repo?.experiments) || repo.experiments.length !== 5) { fail(errors, `repository ${repo?.id ?? "?"} must report five experiments`); continue; }
    trials += repo.experiments.length;
    if (repo.experiments.some((x) => x?.correctness === "regression")) regressions++;
    if (repo.experiments.some((x) => !["pass", "regression"].includes(x?.correctness))) fail(errors, `repository ${repo.id} has experiments without correctness evidence`);
    if (repo.experiments.some((x) => x?.verified === true && (!Number.isFinite(num(x.ratio)) || num(x.ratio) <= 0 || typeof x.commit !== "string" || !x.commit))) fail(errors, `repository ${repo.id} has a verified result without a positive ratio and commit`);
    if (repo.split === "held-out" && repo.experiments.some((x) => x?.verified === true && num(x.ratio) >= 2)) breadth++;
    accepted += repo.experiments.filter((x) => x?.verified === true && typeof x.commit === "string" && x.commit).length;
  }
  if (dev !== 3 || held !== 3 || trials !== 30) fail(errors, "pilot treatment denominator must be 3 development + 3 held-out x 5 experiments = 30");
  if (languages.size < 5) fail(errors, "pilot targets must cover at least five languages");
  if (regressions !== 0) fail(errors, "correctness regression observed");
  if (breadth < 1) fail(errors, "fewer than one held-out repository has a verified 2x win");
  const control = data?.negativeControl;
  if (!control || control.attempts !== 5 || control.commits !== 0 || control.correctnessRegressions !== 0 || control.headroom !== 0 || control.worktreeSharedWithTreatment !== false) fail(errors, "negative control must record five attempts, zero commits, and zero correctness regressions");
  const replays = Array.isArray(data?.replays) ? data.replays : [];
  const acceptedCommits = repos.flatMap((repo) => (repo?.experiments ?? []).filter((x) => x?.verified === true && typeof x.commit === "string").map((x) => x.commit));
  if (accepted !== acceptedCommits.length || replays.length !== acceptedCommits.length || new Set(replays.map((r) => r?.commit)).size !== replays.length || replays.some((r) => r?.cleanCheckout !== true || r.passed !== true || !r.commit || !acceptedCommits.includes(r.commit))) fail(errors, "every accepted commit needs exactly one passing clean-checkout replay and no extra replay rows");
  if (num(data?.evaluatorCv?.wallClock) > 0.05 || num(data?.evaluatorCv?.deterministic) > 0.01) fail(errors, "evaluator CV exceeds the frozen 5% wall-clock or 1% deterministic threshold");
  if (!Number.isFinite(num(data?.evaluatorCv?.wallClock)) || !Number.isFinite(num(data?.evaluatorCv?.deterministic))) fail(errors, "both evaluator CV values are required");
  if (!Number.isFinite(num(data?.spendUsd)) || num(data?.spendUsd) > 1500 || num(data?.spendUsd) < 0) fail(errors, "pilot spend exceeds $1,500 or is invalid");
  const ok = errors.length === 0;
  return { schemaVersion: 1, study: "dream-rsi-pilot", source: data?.source === "fixture" ? "simulated" : "observed", pass: ok,
    denominators: { repositories: repos.length, development: dev, heldOut: held, treatmentExperiments: trials, acceptedCommits: accepted, cleanCheckoutReplays: replays.length },
    heldOutRepositoriesWithVerified2xWin: breadth, correctnessRegressions: regressions, negativeControlCommits: control?.commits ?? null,
    spendUsd: num(data?.spendUsd), errors, conclusion: data?.source === "fixture" ? "SIMULATED ONLY — not study evidence or a magnitude claim" : ok ? "Pilot gate passed; request a separate decision before a larger study" : "Pilot gate failed; preserve the negative result and make no magnitude claim" };
}

export function analyzeEvidence(data) {
  const errors = [];
  if (!validateEvidenceProtocol(evidenceProtocol).ok) fail(errors, "checked-in evidence protocol failed frozen validation");
  if (!data || data.schemaVersion !== 1 || data.study !== "dream-rsi-evidence-track" || !["observed", "fixture"].includes(data.source)) fail(errors, "input is not a v1 evidence-track result set with an explicit observed/fixture source");
  const treatments = Array.isArray(data?.treatmentRepositories) ? data.treatmentRepositories : [];
  let dev = 0; let held = 0; let campaigns = 0; let verifiedWins = 0; let heldOutWins = 0; let heldOutMagnitudeWins = 0; let correctness = 0; const heldRatios = []; const targetIds = new Set(); const languages = new Set();
  if (treatments.length !== 16) fail(errors, "treatment denominator must contain 16 repositories");
  for (const repo of treatments) {
    if (!isRecord(repo)) { fail(errors, "treatment repository record is malformed"); continue; }
    if (!repo.id || targetIds.has(repo.id)) fail(errors, "treatment repository IDs must be unique"); else targetIds.add(repo.id);
    if (typeof repo?.language === "string" && repo.language.trim()) languages.add(repo.language); else fail(errors, `treatment ${repo?.id ?? "?"} needs a language label`);
    if (repo.split === "development") dev++; else if (repo.split === "held-out") held++; else fail(errors, "treatment split must be development or held-out");
    if (!Array.isArray(repo.campaigns) || repo.campaigns.length !== 10) { fail(errors, `treatment ${repo.id ?? "?"} must have ten campaigns`); continue; }
    campaigns += repo.campaigns.length;
    for (const c of repo.campaigns) {
      if (!isRecord(c)) { fail(errors, `treatment ${repo.id} has a malformed campaign record`); continue; }
      if (c.correctness === "regression") correctness++;
      if (c.verifiedWin === true) verifiedWins++;
      if (repo.split === "held-out" && c.verifiedWin === true) heldOutWins++;
      if (c.magnitudeWin === true && c.verifiedWin !== true) fail(errors, `treatment ${repo.id} has a magnitude win without a verified win`);
      if (repo.split === "held-out" && c.verifiedWin === true && c.magnitudeWin === true) heldOutMagnitudeWins++;
      if (repo.split === "held-out" && c.verifiedWin === true && Number.isFinite(c.ratio)) heldRatios.push(c.ratio);
    }
  }
  if (dev !== 10 || held !== 6 || campaigns !== 160) fail(errors, "treatment denominator must be 100 development + 60 held-out campaigns");
  if (languages.size < 8) fail(errors, "treatment harbor must cover at least eight languages");
  const pilotIds = Array.isArray(data?.pilotRepositoryIds) ? data.pilotRepositoryIds : [];
  if (pilotIds.length !== 6 || pilotIds.some((id) => typeof id !== "string" || !id.trim()) || new Set(pilotIds).size !== 6 || pilotIds.some((id) => targetIds.has(id))) fail(errors, "full evidence targets must be six distinct repositories disjoint from the pilot sample");
  if (data?.scopeFrozen !== true || data?.outOfScopeChanges !== 0 || data?.protectedVerifierChanges !== 0) fail(errors, "frozen scope, zero out-of-scope changes, and protected verifier integrity are required");
  const heldWins = treatments.filter((r) => r?.split === "held-out" && r.campaigns?.some((c) => c?.verifiedWin === true && Number(c.ratio) >= 2)).length;
  if (heldWins < 4) fail(errors, "fewer than four of six held-out repositories have a verified 2x win");
  if (heldOutWins < 18) fail(errors, "held-out verified-win rate is below 30% of 60 campaigns");
  if (heldOutMagnitudeWins < 9) fail(errors, "held-out magnitude-win rate is below 15% of 60 campaigns");
  if (correctness > 0) fail(errors, "correctness regression observed");
  if (treatments.some((r) => r?.campaigns?.some((c) => !["pass", "regression"].includes(c?.correctness)))) fail(errors, "treatment campaign lacks correctness evidence");
  if (treatments.some((r) => r?.campaigns?.some((c) => c?.verifiedWin === true && (!c.commit || !Number.isFinite(c.ratio) || c.ratio <= 0)))) fail(errors, "verified treatment campaign lacks a positive ratio or commit ID");
  const controls = data?.negativeControls;
  const controlRows = Array.isArray(controls) ? controls : [];
  if (!Array.isArray(controls) || controls.length !== 4 || new Set(controlRows.filter(isRecord).map((c) => c.id)).size !== 4 || controls.some((c) => !isRecord(c) || typeof c.id !== "string" || !c.id || targetIds.has(c.id) || pilotIds.includes(c.id) || c.campaigns !== 10 || c.commits !== 0 || c.worktreeSharedWithTreatment !== false)) fail(errors, "four distinct isolated negative controls must have ten campaigns and zero commits each");
  for (const control of controlRows) if (isRecord(control) && typeof control.id === "string") targetIds.add(control.id);
  const arms = data?.developmentControlArms;
  if (!arms || arms.repositories !== 10 || arms.campaignsPerArm !== 5 || arms.placebo !== 50 || arms.textbook !== 50 || arms.shuffled !== 50 || arms.aaPairedSequences !== 60 || arms.commits !== 0 || arms.worktreeSharedWithTreatment !== false) fail(errors, "development control arms must preserve exact denominators and remain isolated from treatment");
  const replay = data?.cleanCheckoutReplay;
  if (!replay || replay.passed !== replay.required || replay.required !== verifiedWins || replay.failed !== 0) fail(errors, "all verified wins must pass clean-checkout replay");
  const verifiedCommits = treatments.flatMap((r) => (r?.campaigns ?? []).filter((c) => c?.verifiedWin === true).map((c) => c?.commit));
  const replayRows = Array.isArray(data?.replays) ? data.replays : [];
  if (replayRows.length !== verifiedCommits.length || new Set(replayRows.map((r) => r?.commit)).size !== replayRows.length
    || replayRows.some((r) => !r?.commit || !verifiedCommits.includes(r.commit) || r.cleanCheckout !== true || r.passed !== true)) fail(errors, "every verified win needs exactly one passing clean-checkout replay record");
  const crash = data?.crashRecovery;
  if (!crash || crash.passed !== 12 || crash.required !== 12) fail(errors, "crash recovery gate must pass 12/12");
  const red = data?.redTeam;
  if (!red || red.classes !== 12 || red.repeatsPerClass !== 3 || red.successes !== 0) fail(errors, "red-team gate requires 12 classes x 3 repeats and zero successes");
  if (num(data?.evaluatorCv?.wallClock) > 0.05 || !Number.isFinite(num(data?.evaluatorCv?.wallClock))) fail(errors, "evaluator wall-clock CV exceeds 5% or is missing");
  const totalCost = num(data?.spendUsd); const tokens = num(data?.tokens);
  if (!Number.isFinite(totalCost) || totalCost > 15000 || totalCost < 0) fail(errors, "total spend exceeds $15,000 or is invalid");
  if (!Number.isFinite(tokens) || tokens < 0) fail(errors, "total token spend is missing or invalid");
  if (heldOutWins > 0 && totalCost / heldOutWins > 30) fail(errors, "spend exceeds $30 per held-out verified win");
  if (heldOutWins > 0 && tokens / heldOutWins > 250000) fail(errors, "token spend exceeds 250,000 per held-out verified win");
  const perRepo = treatments.some((r) => !Number.isFinite(num(r?.tokens)) || !Number.isFinite(num(r?.spendUsd)) || num(r?.tokens) > 750000 || num(r?.spendUsd) > 90);
  if (perRepo) fail(errors, "a treatment repository is missing spend evidence or exceeds 750,000 tokens or $90");
  if (heldRatios.length) {
    const sorted = [...heldRatios].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    if (median < 1.5) fail(errors, "held-out median verified ratio is below 1.5");
    if (num(data?.ratioCiLower95) <= 1.15 || !Number.isFinite(num(data?.ratioCiLower95))) fail(errors, "95% CI lower bound must exceed 1.15");
  } else fail(errors, "no verified held-out ratios are available");
  const ok = errors.length === 0;
  return { schemaVersion: 1, study: "dream-rsi-evidence-track", source: data?.source === "fixture" ? "simulated" : "observed", pass: ok,
    denominators: { treatmentRepositories: treatments.length, developmentRepositories: dev, heldOutRepositories: held, developmentCampaigns: dev * 10, heldOutCampaigns: held * 10, treatmentCampaigns: campaigns, negativeControlRepositories: controlRows.length, negativeControlCampaigns: controlRows.reduce((n, c) => n + (Number(c?.campaigns) || 0), 0), verifiedWins, heldOutVerifiedWins: heldOutWins, heldOutMagnitudeWins },
    correctnessRegressions: correctness, killTriggered: !ok, errors,
    conclusion: data?.source === "fixture" ? "SIMULATED ONLY — no evidence or magnitude claim" : ok ? "All declared gates passed; publication remains a separate approval" : "Kill condition triggered; preserve result and make no magnitude claim" };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const mode = args.includes("--evidence") ? "evidence" : "pilot";
  const inputArg = args.find((x) => !x.startsWith("--"));
  if (!inputArg) { console.error("Usage: node harbor/analyze.mjs [--evidence] RESULTS.json"); process.exit(2); }
  const data = JSON.parse(fs.readFileSync(path.resolve(inputArg), "utf8"));
  const report = mode === "evidence" ? analyzeEvidence(data) : analyzePilot(data);
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}
