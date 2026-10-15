#!/usr/bin/env node
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, "..");
const PACKAGE_MARKER = "prompts/discovery-agent.md";
const PROBLEM = "PROBLEM.md";
const POLICY_GATE = `import { readPolicyViolations } from "../extensions/pi-dream-rsi/policy/runner.ts";\n\nconst target = process.argv[2] ?? "policy/method.ts";\nconst violations = readPolicyViolations(target);\nif (violations.length > 0) {\n  console.error(violations.join("\\n"));\n  process.exitCode = 1;\n} else {\n  console.log("policy contract passed");\n}\n`;
const GENERATED = new Map([
  ["package.json", `${JSON.stringify({ name: "dream-rsi-self-verifier", private: true, type: "module" }, null, 2)}\n`],
  [".auto/policy-gate.mjs", POLICY_GATE],
]);
const STATIC_SPECIFIER = /\b(?:import|export)\s+(?:[^"'()]*?\sfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function moduleFiles(root, entries) {
  const found = new Set();
  const pending = [...entries];
  while (pending.length > 0) {
    const relative = pending.pop().replaceAll("\\", "/");
    if (found.has(relative)) continue;
    const absolute = path.resolve(root, relative);
    const rel = path.relative(root, absolute);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`verifier import escapes package root: ${relative}`);
    }
    const source = GENERATED.has(relative)
      ? GENERATED.get(relative)
      : fs.readFileSync(absolute, "utf8");
    found.add(relative);
    for (const match of source.matchAll(STATIC_SPECIFIER)) {
      const specifier = match[1] ?? match[2];
      if (!specifier.startsWith(".")) continue;
      const target = path.resolve(path.dirname(absolute), specifier);
      const targetRelative = path.relative(root, target);
      if (targetRelative === ".." || targetRelative.startsWith(`..${path.sep}`) || path.isAbsolute(targetRelative)) {
        throw new Error(`verifier import escapes package root: ${relative} -> ${specifier}`);
      }
      if (!fs.existsSync(target)) throw new Error(`verifier import is missing: ${relative} -> ${specifier}`);
      if (fs.statSync(target).isFile()) pending.push(targetRelative.replaceAll("\\", "/"));
    }
  }
  return found;
}

function verifierInputs(root) {
  const files = moduleFiles(root, [
    ".auto/score.mjs",
    "extensions/pi-dream-rsi/worker/policy-worker.ts", // worker path is constructed with new URL at runtime
    "extensions/pi-dream-rsi/policy/api.ts", // copied by ensurePolicyRuntime using a filename list
    "extensions/pi-dream-rsi/policy/observation-signal.ts", // copied by ensurePolicyRuntime using a filename list
    ".auto/policy-gate.mjs",
  ]);
  for (const required of [PACKAGE_MARKER, PROBLEM]) {
    if (!fs.existsSync(path.join(root, required))) throw new Error(`required protected input is missing: ${required}`);
    files.add(required);
  }
  for (const [relative, content] of GENERATED) {
    if (!files.has(relative)) files.add(relative);
    // The manifest hashes generated content without writing it into the source repository.
    if (typeof content !== "string") throw new Error(`invalid generated input: ${relative}`);
  }
  return [...files].sort().map((relative) => {
    const bytes = GENERATED.has(relative)
      ? Buffer.from(GENERATED.get(relative), "utf8")
      : fs.readFileSync(path.join(root, ...relative.split("/")));
    return { relative, bytes, sha256: sha256(bytes) };
  });
}

function snapshotHash(files) {
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file.relative, "utf8");
    hash.update("\0");
    hash.update(String(file.bytes.length), "utf8");
    hash.update("\0");
    hash.update(file.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function verifyExisting(destination, files, expectedHash) {
  const manifestPath = path.join(destination, "snapshot.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.hash !== expectedHash) throw new Error(`snapshot hash mismatch at ${destination}`);
  const expected = new Map(files.map(({ relative, sha256: digest }) => [relative, digest]));
  const recorded = new Map(manifest.files.map(({ path: relative, sha256: digest }) => [relative, digest]));
  if (expected.size !== recorded.size || [...expected].some(([relative, digest]) => recorded.get(relative) !== digest)) {
    throw new Error(`snapshot file list mismatch at ${destination}`);
  }
  for (const [relative, digest] of expected) {
    const file = path.join(destination, ...relative.split("/"));
    if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== digest) {
      throw new Error(`existing verifier snapshot was changed and will not be overwritten: ${file}`);
    }
  }
}

function writeSnapshot(destination, files, hash) {
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const staging = path.join(parent, `.staging-${process.pid}-${crypto.randomUUID()}`);
  fs.mkdirSync(staging);
  try {
    for (const { relative, bytes } of files) {
      const target = path.join(staging, ...relative.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: "wx" });
    }
    const manifest = {
      version: 1,
      hash,
      files: files.map(({ relative, sha256: digest }) => ({ path: relative, sha256: digest })),
    };
    fs.writeFileSync(path.join(staging, "snapshot.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(staging, destination);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function quoted(value) {
  if (process.platform === "win32") {
    if (/["%\r\n]/.test(value)) throw new Error("verifier paths containing quotes, percent signs or newlines cannot be passed safely through the Windows command shell");
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function setupSelfCampaign(projectDir = PACKAGE_ROOT, sourceRoot = PACKAGE_ROOT) {
  const canonicalProject = fs.realpathSync(projectDir);
  const canonicalSource = fs.realpathSync(sourceRoot);
  const files = verifierInputs(canonicalSource);
  const hash = snapshotHash(files);
  const verifierRoot = path.join(canonicalProject, ".dream-rsi", "verifier", hash);
  if (fs.existsSync(verifierRoot)) verifyExisting(verifierRoot, files, hash);
  else writeSnapshot(verifierRoot, files, hash);

  const baseRoot = path.join(canonicalProject, ".dream-rsi");
  const scorer = path.join(verifierRoot, ".auto", "score.mjs");
  const gate = path.join(verifierRoot, ".auto", "policy-gate.mjs");
  const snapshotFiles = files.map(({ relative }) => path.join(verifierRoot, ...relative.split("/")));
  const candidatePath = "extensions/pi-dream-rsi/policy/method.ts";
  const intake = {
    action: "start",
    goal: "Improve exploration-policy replay score while preserving determinism and the policy contract.",
    project_dir: canonicalProject,
    task: {
      name: "Dream-RSI exploration policy",
      workspace: ".",
      eval_program: candidatePath,
      score_program: `node ${quoted(scorer)} --benchmark-version=2`,
      problem_file: path.relative(canonicalProject, path.join(verifierRoot, PROBLEM)),
      evaluator_timeout_ms: 300_000,
      agent_timeout_ms: 300_000,
      copy_exclude: ["node_modules"],
    },
    scope: [candidatePath],
    verifier_inputs: [...snapshotFiles, path.join(verifierRoot, "snapshot.json")],
    gates: [`node ${quoted(gate)} ${candidatePath}`, "npm test"],
    minimum_gain: undefined,
  };
  const intakePath = path.join(baseRoot, `self-campaign-${hash}.json`);
  const serialized = `${JSON.stringify(intake, null, 2)}\n`;
  fs.mkdirSync(baseRoot, { recursive: true });
  if (fs.existsSync(intakePath) && fs.readFileSync(intakePath, "utf8") !== serialized) {
    throw new Error(`existing campaign intake was not changed: ${intakePath}`);
  }
  if (!fs.existsSync(intakePath)) fs.writeFileSync(intakePath, serialized, { flag: "wx" });
  return { hash, verifierRoot, intakePath, intake };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = setupSelfCampaign(process.argv[2] ? path.resolve(process.argv[2]) : PACKAGE_ROOT);
    console.log(JSON.stringify({ snapshot: result.verifierRoot, hash: result.hash, intake: result.intakePath }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
