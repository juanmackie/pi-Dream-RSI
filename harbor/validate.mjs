import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function validateEvidenceProtocol(protocol) {
  const errors = [];
  const d = protocol?.denominators; const c = protocol?.claim; const caps = protocol?.caps;
  if (protocol?.schemaVersion !== 1 || protocol?.study !== "dream-rsi-evidence-track" || protocol?.status !== "optional-design-only") errors.push("evidence protocol identity/status is invalid");
  if (!d || d.pilotOverlapAllowed !== false || d.treatmentRepositories !== 16 || d.developmentRepositories !== 10 || d.heldOutRepositories !== 6
    || d.campaignsPerTreatmentRepository !== 10 || d.developmentCampaigns !== 100 || d.heldOutCampaigns !== 60
    || d.negativeControlRepositories !== 4 || d.campaignsPerNegativeControl !== 10 || d.negativeControlCampaigns !== 40
    || d.developmentControlRepositories !== 10 || d.campaignsPerDevelopmentControlArm !== 5 || d.placeboCampaigns !== 50
    || d.textbookCampaigns !== 50 || d.shuffledMetricCampaigns !== 50 || d.aaPairedSequences !== 60 || d.redTeamClasses !== 12 || d.redTeamRepeatsPerClass !== 3) errors.push("evidence denominators differ from the frozen protocol");
  if (!c || c.heldOutRepositories !== 6 || c.verifiedTwoXRepositoriesMinimum !== 4 || c.heldOutCampaigns !== 60
    || c.verifiedWinRateMinimum !== 0.3 || c.magnitudeWinRateMinimum !== 0.15 || c.medianRatioMinimum !== 1.5
    || c.ratioCiLower95ExclusiveMinimum !== 1.15 || c.correctnessRegressionsMaximum !== 0 || c.negativeControlCommitsMaximum !== 0
    || c.cleanCheckoutReplayRate !== 1 || c.crashRecoveries?.passed !== 12 || c.crashRecoveries?.required !== 12
    || c.evaluatorCvMaximum !== 0.05 || c.tokensPerHeldOutVerifiedWinMaximum !== 250000 || c.usdPerHeldOutVerifiedWinMaximum !== 30) errors.push("evidence pass thresholds differ from the frozen protocol");
  if (!caps || caps.tokensPerTreatmentRepository !== 750000 || caps.usdPerTreatmentRepository !== 90 || caps.totalUsd !== 15000) errors.push("evidence cost caps differ from the frozen protocol");
  if (protocol?.controlIsolation?.controlsShareTreatmentWorktree !== false || protocol?.controlIsolation?.controlsMayCommit !== false
    || protocol?.controlIsolation?.negativeControlHeadroom !== 0 || protocol?.controlIsolation?.treatmentScopeFrozenBeforeHeldOut !== true
    || protocol?.controlIsolation?.heldOutRepositoriesRemainSealedUntilFreeze !== true) errors.push("evidence control-isolation rules differ from the frozen protocol");
  if (!Array.isArray(protocol?.killConditions) || protocol.killConditions.length !== 6) errors.push("evidence kill conditions are incomplete");
  return { ok: errors.length === 0, errors };
}

export function validatePilot(manifest, { ready = false, baseDir = process.cwd() } = {}) {
  const errors = [];
  if (!manifest || manifest.schemaVersion !== 1 || manifest.study !== "dream-rsi-pilot" || manifest.frozen !== true) errors.push("pilot identity/schema is not frozen");
  if (manifest?.status !== "design-only") errors.push("only a design-only manifest is accepted by this tooling");
  if (manifest?.repositoryCount !== 6 || manifest?.split?.development !== 3 || manifest?.split?.heldOut !== 3) errors.push("pilot denominator must remain 3 development + 3 held-out repositories");
  if (manifest?.minimumLanguages !== 5 || manifest?.experimentsPerRepository !== 5) errors.push("language and experiment requirements differ from the frozen pilot");
  if (manifest?.negativeControl?.attempts !== 5 || manifest?.negativeControl?.maximumCommits !== 0) errors.push("negative-control gate differs from the frozen pilot");
  if (manifest?.replay?.requiredRate !== 1 || manifest?.replay?.requireCleanCheckout !== true) errors.push("clean-checkout replay gate differs from the frozen pilot");
  if (manifest?.budgetUsdMaximum !== 1500 || manifest?.pass?.maximumCorrectnessRegressions !== 0 || manifest?.pass?.heldOutRepositoriesWithVerified2xWin !== 1) errors.push("pass or cost gate differs from the frozen pilot");
  if (manifest?.evaluatorCvMaximum?.wallClock !== 0.05 || manifest?.evaluatorCvMaximum?.deterministic !== 0.01) errors.push("evaluator CV limits differ from the frozen pilot");
  if (!Array.isArray(manifest?.repositories) || manifest.repositories.length > 6) errors.push("repositories must be an array of at most six targets");
  const repos = Array.isArray(manifest?.repositories) ? manifest.repositories : [];
  if (ready && repos.length !== 6) errors.push("ready mode requires all six operator-approved repository pins");
  const ids = new Set(); const sources = new Set(); const languages = new Set(); let development = 0; let heldOut = 0;
  for (const repo of repos) {
    if (!repo || typeof repo.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(repo.id) || ids.has(repo.id)) errors.push("repository IDs must be unique safe slugs");
    else ids.add(repo.id);
    if (repo?.split === "development") development += 1; else if (repo?.split === "held-out") heldOut += 1; else errors.push("each repository must belong to development or held-out");
    if (typeof repo?.language !== "string" || !repo.language.trim()) errors.push(`repository ${repo?.id ?? "?"} needs a language label`); else languages.add(repo.language);
    if (typeof repo?.sha !== "string" || !/^[a-f0-9]{40,64}$/i.test(repo.sha)) errors.push(`repository ${repo?.id ?? "?"} needs a full pinned Git SHA`);
    if (typeof repo?.source !== "string" || !repo.source.trim() || /^[a-z]+:\/\//i.test(repo.source)) errors.push(`repository ${repo?.id ?? "?"} needs a local source path, not a URL`);
    else {
      const source = path.resolve(baseDir, repo.source);
      if (sources.has(source)) errors.push(`repository ${repo.id} reuses another target source path`); else sources.add(source);
      if (!ready) continue;
      if (!fs.existsSync(source)) errors.push(`repository ${repo.id} local source does not exist`);
      else {
        try {
          const head = execFileSync("git", ["-C", source, "rev-parse", "--verify", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
          if (head.toLowerCase() !== repo.sha.toLowerCase()) errors.push(`repository ${repo.id} HEAD differs from its pinned SHA`);
        } catch { errors.push(`repository ${repo.id} is not a readable Git checkout`); }
      }
    }
  }
  if (repos.length === 6 && (development !== 3 || heldOut !== 3)) errors.push("repository split must contain exactly three development and three held-out targets");
  if (repos.length === 6 && languages.size < 5) errors.push("the six targets must cover at least five languages");
  return { ok: errors.length === 0, errors, configuredRepositories: repos.length, ready: repos.length === 6 && errors.length === 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const ready = args.includes("--ready"); const evidence = args.includes("--evidence");
  const input = args.find((arg) => !arg.startsWith("--")) ?? path.join(path.dirname(fileURLToPath(import.meta.url)), evidence ? "evidence-protocol.json" : "pilot.json");
  const manifest = JSON.parse(fs.readFileSync(path.resolve(input), "utf8"));
  const result = evidence ? validateEvidenceProtocol(manifest) : validatePilot(manifest, { ready, baseDir: path.dirname(path.resolve(input)) });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok || (ready && !result.ready)) process.exitCode = 1;
}
