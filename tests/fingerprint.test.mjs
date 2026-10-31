/**
 * The durable project card.
 *
 * The card is advisory evidence: it records what the scanner can see, never runs
 * a project command, and refuses a stale or tampered digest. These tests pin the
 * bounded scan, the ranking signals, and the persistence contract.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  PROJECT_CARD_FILE, buildProjectCard, magnitudeForScope, projectCardDigest, projectCardSummary,
  projectLanguageOf, readProjectCard, writeProjectCard,
} from "../extensions/pi-dream-rsi/engine/fingerprint.ts";

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-card-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

const NESTED_LOOPS = `export function run(items) {
  let total = 0;
  for (const item of items) {
    for (const value of item) total += value;
  }
  return total;
}
`;

const FIXTURE = {
  "package.json": `${JSON.stringify({
    name: "card-fixture", private: true, type: "module",
    scripts: { test: "node --test", bench: "node bench.mjs", "bench:slow": "node bench.mjs", build: "tsc" },
    dependencies: { leftpad: "^1.0.0", old: "^0.9.0", floating: "*" },
    devDependencies: { typescript: "^5.0.0" },
  }, null, 2)}\n`,
  "bench.mjs": 'import { run } from "./src/hot.mjs";\nrun();\n',
  "src/hot.mjs": NESTED_LOOPS,
  "src/util.mjs": "export const helper = () => 1;\n",
  "src/consumer.mjs": 'import { helper } from "./util.mjs";\nexport const consume = () => helper();\n',
  "src/app.py": `def run(items):
    total = 0
    for item in items:
        for value in item:
            total += value
    return total
`,
  "src/cycle-a.mjs": 'import "./cycle-b.mjs";\nexport const a = 1;\n',
  "src/cycle-b.mjs": 'import "./cycle-a.mjs";\nexport const b = 1;\n',
  "pyproject.toml": "[project]\nname = \"fixture\"\ndependencies = [\"requests>=2.0\", \"oldpy==0.3.0\"]\n",
  ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - run: npm test\n      - run: npm run bench\n",
  Makefile: "bench:\n\tnode bench.mjs\n",
  ".env": "SECRET=1\n",
  "src/secrets/key.mjs": "export const key = 1;\n",
};

test("the card records languages, managers, runners, commands, hotspots and dependency signals", () => {
  const dir = project(FIXTURE);
  const card = buildProjectCard(dir, { now: new Date("2026-10-31T00:00:00.000Z") });

  assert.equal(card.version, 1);
  assert.equal(card.generatedAt, "2026-10-31T00:00:00.000Z");
  assert.deepEqual(card.languages.map((entry) => entry.name).sort(), ["JavaScript", "Python"]);
  assert.ok(card.packageManagers.includes("npm"), "package.json without another lockfile is still npm");
  assert.ok(card.packageManagers.includes("pip"));
  assert.ok(card.testRunners.includes("package.json#test"));
  assert.ok(card.testRunners.includes("node --test"));
  assert.ok(card.testRunners.includes("pytest"));
  assert.ok(card.benchmarkCommands.includes("npm run bench"));
  assert.ok(card.benchmarkCommands.includes("npm run bench:slow"));
  assert.ok(card.benchmarkCommands.includes("make bench"));
  assert.deepEqual(card.ciCommands, ["npm test", "npm run bench"]);

  const hot = card.hotspots.find((entry) => entry.path === "src/hot.mjs");
  assert.ok(hot, "the measured hot path is a hotspot");
  assert.ok(hot.inboundImports >= 1, "the benchmark entry imports the hot path");
  assert.ok(hot.reasons.some((reason) => /signals: nested-loops/.test(reason)));
  assert.ok(card.hotspots.every((entry) => !entry.path.includes("secrets") && entry.path !== ".env"), "secret-shaped paths are never scanned");

  const packageSignal = card.dependencies.find((entry) => entry.manifest === "package.json");
  assert.equal(packageSignal.declared, 4);
  assert.equal(packageSignal.unpinned, 1, "the wildcard dependency is unpinned");
  assert.equal(packageSignal.preMajor, 1, "the 0.x dependency is pre-1.0");
  const pythonSignal = card.dependencies.find((entry) => entry.manifest === "pyproject.toml");
  assert.equal(pythonSignal.declared, 2);
  assert.equal(pythonSignal.preMajor, 1);

  assert.ok(card.architecture.some((smell) => smell.kind === "import-cycle"));
  assert.ok(card.architecture.some((smell) => smell.kind === "unreachable-module" && smell.path === "src/consumer.mjs"));

  assert.ok(card.magnitudeCandidates.some((candidate) => candidate.campaignType === "algorithmic" && candidate.path === "src/hot.mjs"));
  assert.ok(card.magnitudeCandidates.some((candidate) => candidate.campaignType === "algorithmic" && candidate.path === "src/app.py"));
});

test("the digest ignores the timestamp but changes with content", () => {
  const dir = project(FIXTURE);
  const first = buildProjectCard(dir, { now: new Date("2026-10-31T00:00:00.000Z") });
  const second = buildProjectCard(dir, { now: new Date("2026-11-01T00:00:00.000Z") });
  assert.equal(first.digest, second.digest, "a rebuild of unchanged content keeps the same identity");
  const { digest, ...withoutDigest } = first;
  assert.equal(projectCardDigest(withoutDigest), digest);

  fs.writeFileSync(path.join(dir, "src", "hot.mjs"), `${NESTED_LOOPS}\nexport const changed = true;\n`);
  const changed = buildProjectCard(dir);
  assert.notEqual(changed.digest, first.digest);
});

test("the card round-trips, and a corrupt or tampered file is treated as absent", () => {
  const dir = project(FIXTURE);
  const card = buildProjectCard(dir);
  const file = writeProjectCard(dir, card);
  assert.equal(file, path.join(dir, ...PROJECT_CARD_FILE.split("/")));
  assert.deepEqual(readProjectCard(dir), card);

  fs.writeFileSync(file, `${JSON.stringify({ ...card, hotspots: [] }, null, 2)}\n`);
  assert.equal(readProjectCard(dir), null, "a changed body without a new digest is not evidence");

  fs.writeFileSync(file, "{broken");
  assert.equal(readProjectCard(dir), null);
});

test("scope magnitude reads the editable files and falls back safely", () => {
  const dir = project(FIXTURE);
  const card = buildProjectCard(dir);
  assert.equal(magnitudeForScope(dir, ["src/hot.mjs"], card).campaignType, "algorithmic");
  assert.equal(magnitudeForScope(dir, ["src/util.mjs"], card).campaignType, "local-hill");
  assert.equal(magnitudeForScope(dir, [], card).campaignType, "local-hill");
  assert.equal(magnitudeForScope(dir, ["src/missing.mjs", ".env", "../outside.mjs"], card).campaignType, "local-hill");
});

test("the summary is short, honest and names the strongest candidates", () => {
  const dir = project(FIXTURE);
  const lines = projectCardSummary(buildProjectCard(dir));
  const text = lines.join("\n");
  assert.match(text, /Project card: JavaScript/);
  assert.match(text, /package managers: .*npm/);
  assert.match(text, /magnitude candidates: algorithmic/);
  assert.ok(lines.length <= 8, "status output stays bounded");
});

test("the language detector covers common extensions and refuses unknown ones", () => {
  assert.equal(projectLanguageOf("src/app.ts"), "TypeScript");
  assert.equal(projectLanguageOf("src/app.mjs"), "JavaScript");
  assert.equal(projectLanguageOf("src/app.py"), "Python");
  assert.equal(projectLanguageOf("src/app.rs"), "Rust");
  assert.equal(projectLanguageOf("src/app.unknown"), null);
});
