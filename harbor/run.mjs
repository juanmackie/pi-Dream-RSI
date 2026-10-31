import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateEvidenceProtocol, validatePilot } from "./validate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const pilotMode = args.includes("--pilot");
const evidenceMode = args.includes("--evidence");
if (pilotMode === evidenceMode) {
  console.error("Usage: node harbor/run.mjs (--pilot [--manifest FILE] | --evidence) [--out FILE]");
  process.exit(2);
}
let schedule;
if (pilotMode) {
  const manifestArg = args.indexOf("--manifest");
  const manifestPath = path.resolve(manifestArg >= 0 ? args[manifestArg + 1] ?? "" : path.join(here, "pilot.json"));
  if (manifestArg >= 0 && !args[manifestArg + 1]) { console.error("--manifest requires a file path"); process.exit(2); }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const validation = validatePilot(manifest, { ready: false, baseDir: path.dirname(manifestPath) });
  if (!validation.ok) { console.error(JSON.stringify(validation, null, 2)); process.exit(1); }
  const slots = manifest.repositories.flatMap((repo) => Array.from({ length: manifest.experimentsPerRepository }, (_, index) => ({
    repository: repo.id, split: repo.split, attempt: index + 1, pinnedSha: repo.sha, state: "pending",
  })));
  schedule = {
    schemaVersion: 1, study: manifest.study, mode: "schedule-only", executed: false,
    note: "No repository code, evaluator, model, or network was run. This file is a pending schedule, not study evidence.",
    denominators: { repositories: manifest.repositoryCount, development: manifest.split.development, heldOut: manifest.split.heldOut, experiments: manifest.repositoryCount * manifest.experimentsPerRepository },
    configuredRepositories: validation.configuredRepositories, needsOperatorPins: validation.configuredRepositories !== manifest.repositoryCount, slots,
  };
} else {
  const protocol = JSON.parse(fs.readFileSync(path.join(here, "evidence-protocol.json"), "utf8"));
  const validation = validateEvidenceProtocol(protocol);
  if (!validation.ok) { console.error(JSON.stringify(validation, null, 2)); process.exit(1); }
  schedule = {
    schemaVersion: 1, study: protocol.study, mode: "schedule-only", executed: false,
    note: "No repository code, evaluator, model, or network was run. This is a protocol schedule, not study evidence.",
    denominators: protocol.denominators, caps: protocol.caps,
    requiresSeparateExecutionApproval: true, slots: [],
  };
}
const outArg = args.indexOf("--out");
if (outArg >= 0) {
  if (!args[outArg + 1]) { console.error("--out requires a file path"); process.exit(2); }
  const out = path.resolve(args[outArg + 1]);
  fs.writeFileSync(out, `${JSON.stringify(schedule, null, 2)}\n`, { flag: "wx" });
  console.log(`Pending schedule written to ${out}; no experiments executed.`);
} else console.log(JSON.stringify(schedule, null, 2));
