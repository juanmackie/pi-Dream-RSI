import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { collectSignals } from "../extensions/pi-dream-rsi/engine/signals.ts";
import { buildLeverInventory, leverIntake } from "../extensions/pi-dream-rsi/engine/levers.ts";

const NOW = new Date("2026-10-15T00:00:00.000Z");
const SECRET = "sk-live-fixture-secret-9988";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-levers-"));
}

function writeSession(sessionDir, projectDir, entries, name = "session.jsonl", mtime = NOW) {
  fs.mkdirSync(sessionDir, { recursive: true });
  const header = { type: "session", version: 3, id: name, timestamp: mtime.toISOString(), cwd: projectDir };
  const file = path.join(sessionDir, name);
  fs.writeFileSync(file, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  fs.utimesSync(file, mtime, mtime);
  return file;
}

function toolEntry(id, name, arguments_, time) {
  return {
    type: "message", id: `entry-${id}`, parentId: null, timestamp: new Date(time).toISOString(),
    message: {
      role: "assistant", content: [{ type: "toolCall", id, name, arguments: arguments_ }],
      timestamp: time, provider: "fixture", model: "fixture", api: "fixture", usage: {}, stopReason: "toolUse",
    },
  };
}

function toolResult(id, name, text, time, { isError = false, details } = {}) {
  return {
    type: "message", id: `result-${id}`, parentId: null, timestamp: new Date(time).toISOString(),
    message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: time, details },
  };
}

/** A Node project whose sessions show a failing and slow npm test plus follow-up edits. */
async function nodeProjectInventory() {
  const projectDir = tempDir();
  const sessionDir = path.join(projectDir, "sessions");
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ scripts: { test: "node -e 0", bench: "node bench.mjs" } }));
  const t0 = NOW.getTime() - 60_000;
  writeSession(sessionDir, projectDir, [
    toolEntry("fail-1", "bash", { command: `npm test -- --token=${SECRET}` }, t0),
    toolResult("fail-1", "bash", `Error: command failed with token ${SECRET}`, t0 + 2500, { isError: true }),
    toolEntry("edit-1", "edit", { path: "src/parser.ts", edits: [{ oldText: "a", newText: "b" }] }, t0 + 2600),
    toolResult("edit-1", "edit", "edited", t0 + 2700),
    toolEntry("fail-2", "bash", { command: "npm test" }, t0 + 3000),
    toolResult("fail-2", "bash", "Error: command failed", t0 + 3500, { isError: true }),
    toolEntry("edit-2", "write", { path: "src/lexer.ts", content: "fix" }, t0 + 3600),
    toolResult("edit-2", "write", "written", t0 + 3700),
    toolEntry("fail-3", "bash", { command: "npm test" }, t0 + 4000),
    toolResult("fail-3", "bash", "Error: command failed", t0 + 4500, { isError: true }),
    toolEntry("slow", "bash", { command: "npm test" }, t0 + 5000),
    toolResult("slow", "bash", "ok", t0 + 5000 + 42_000, { details: { durationMs: 42_000 } }),
  ]);
  const signals = await collectSignals({ projectDir, sessionDir, now: NOW });
  return { projectDir, signals };
}

test("inventory ranks measured command levers with declared gates and stays deterministic", async () => {
  const { projectDir, signals } = await nodeProjectInventory();
  try {
    const inventory = buildLeverInventory({ weaknesses: signals.weaknesses });
    assert.equal(inventory.levers[0].sourceKind, "slow-command");
    assert.equal(inventory.levers[0].metricKind, "command-duration");
    assert.equal(inventory.levers[1].sourceKind, "session-failure");
    assert.equal(inventory.levers[2].sourceKind, "post-failure-edits");
    for (const lever of inventory.levers) assert.deepEqual(lever.gates, ["npm test"]);
    const scope = inventory.levers[2].scopeFiles;
    assert.ok(scope.includes("src/parser.ts") && scope.includes("src/lexer.ts"), `scope files: ${scope.join(", ")}`);
    const command = inventory.levers[1];
    assert.ok(command.scopeFiles.includes("src/parser.ts") && command.scopeFiles.includes("src/lexer.ts"),
      `command lever discovers the same post-failure files as scope: ${command.scopeFiles.join(", ")}`);
    assert.ok(command.reasons.some((reason) => /scope: 2 known file/.test(reason)));
    assert.ok(inventory.levers.every((lever) => lever.reasons.length >= 2), "every lever carries evidence reasons");
    assert.ok(inventory.diagnostics.some((line) => /Declared test gates: npm test/.test(line)));
    assert.ok(inventory.diagnostics.some((line) => /treated as gate capability, not as levers/.test(line)));

    const rebuilt = buildLeverInventory({ weaknesses: signals.weaknesses });
    assert.equal(JSON.stringify(inventory), JSON.stringify(rebuilt), "inventory is deterministic for identical inputs");
    assert.doesNotMatch(JSON.stringify(inventory), new RegExp(SECRET), "raw private text never reaches the inventory");
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

test("recorded attempts demote a lever and cite the history in its reasons", async () => {
  const { projectDir, signals } = await nodeProjectInventory();
  try {
    const base = buildLeverInventory({ weaknesses: signals.weaknesses });
    const proven = base.levers.find((lever) => lever.sourceKind === "slow-command");
    const demoted = buildLeverInventory({
      weaknesses: signals.weaknesses,
      attempts: [{ leverId: proven.id, outcome: "win" }],
    });
    assert.equal(demoted.levers[0].sourceKind, "session-failure", "a verified win moves the loop to the next lever");
    const same = demoted.levers.find((lever) => lever.id === proven.id);
    assert.ok(same.score < proven.score * 0.2, `demoted score ${same.score} vs original ${proven.score}`);
    assert.ok(same.reasons.some((reason) => /prior outcome win/.test(reason)));
    assert.deepEqual(same.estimates, proven.estimates, "demotion changes ranking, not the raw estimate");
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

test("advisory and unmeasurable signals are rejected with explicit reasons, never as levers", () => {
  const inv = buildLeverInventory({
    weaknesses: [
      { kind: "session-tool-error", summary: "5 tool errors were recorded.", evidence: [{ source: "session", ref: "tool-error", count: 5 }], suggestedMetric: "Reduce tool errors." },
      { kind: "git-churn", summary: "Most changed safe paths: src/a.ts (9).", evidence: [{ source: "git", ref: "src/a.ts", count: 9 }], suggestedMetric: "Measure the goal-specific outcome." },
      { kind: "session-failure", summary: "shell command failed 2 times.", evidence: [{ source: "session", ref: "shell command", count: 2 }], suggestedMetric: "Reduce failed shell command runs." },
      { kind: "campaign-health", summary: "Prior campaign ledgers record 12 events.", evidence: [{ source: "campaign", ref: "ledger events", count: 12 }], suggestedMetric: "Improve confirmation rate." },
    ],
  });
  assert.deepEqual(inv.levers, []);
  assert.equal(inv.rejected.length, 4);
  const reasonFor = (kind) => inv.rejected.find((entry) => entry.sourceKind === kind)?.reason ?? "";
  assert.match(reasonFor("session-failure"), /cannot be reconstructed/);
  assert.match(reasonFor("git-churn"), /churn-only evidence/);
  assert.match(reasonFor("session-tool-error"), /session-tooling signal/);
  assert.match(reasonFor("campaign-health"), /campaign-history signal/);
  assert.ok(inv.diagnostics.some((line) => /No lever passed verification-readiness screening/.test(line)));
});

test("python projects map to pytest through the same canonical heads, with no repository-specific branching", async () => {
  const projectDir = tempDir();
  const sessionDir = path.join(projectDir, "sessions");
  fs.writeFileSync(path.join(projectDir, "pyproject.toml"), `[tool.pytest.ini_options]\naddopts = "-q"\n`);
  const t0 = NOW.getTime() - 30_000;
  writeSession(sessionDir, projectDir, [
    toolEntry("py-1", "bash", { command: "pytest tests/" }, t0),
    toolResult("py-1", "bash", "Error: test failed", t0 + 900, { isError: true }),
    toolEntry("py-2", "bash", { command: "python -m pytest -q" }, t0 + 1000),
    toolResult("py-2", "bash", "Error: test failed", t0 + 1800, { isError: true }),
  ]);
  try {
    const signals = await collectSignals({ projectDir, sessionDir, now: NOW });
    const inventory = buildLeverInventory({ weaknesses: signals.weaknesses });
    const top = inventory.levers[0];
    assert.equal(top.sourceKind, "session-failure");
    assert.equal(top.metricKind, "command-success", "the same metric kind applies across language stacks");
    assert.match(top.goal, /"pytest"/);
    assert.deepEqual(top.gates, ["pytest"]);
    assert.doesNotMatch(JSON.stringify(inventory), /npm/, "no Node-specific command leaks into a Python project");
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

test("lever intake marks levers with discovered scope ready and scopeless levers as needing setup", async () => {
  const { projectDir, signals } = await nodeProjectInventory();
  try {
    const inventory = buildLeverInventory({ weaknesses: signals.weaknesses });
    const scoped = inventory.levers.find((lever) => lever.sourceKind === "post-failure-edits");
    const command = inventory.levers.find((lever) => lever.sourceKind === "session-failure");
    assert.equal(leverIntake(scoped).readiness, "ready");
    assert.equal(leverIntake(command).readiness, "ready", "session edit evidence makes the failing command lever ready");
    assert.ok(leverIntake(command).scope_files.length > 0, "the discovered scope is exposed to intake");
    assert.deepEqual(leverIntake(scoped).scope_files, scoped.scopeFiles);
    const scopelessInventory = buildLeverInventory({
      weaknesses: [{
        kind: "session-failure", summary: "npm test failed 2 times.",
        evidence: [{ source: "session", ref: "npm test", count: 2 }],
        suggestedMetric: "Reduce failed npm test runs.",
      }],
    });
    const scopeless = scopelessInventory.levers.find((lever) => lever.sourceKind === "session-failure");
    assert.equal(leverIntake(scopeless).readiness, "needs_setup", "a command failure with no recorded follow-up edit stays unscoped");
    for (const lever of [scoped, command]) {
      const intake = leverIntake(lever);
      assert.equal(intake.evaluator_kind, "command");
      assert.ok(intake.goal.length > 0 && intake.metric.length > 0);
    }
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});
