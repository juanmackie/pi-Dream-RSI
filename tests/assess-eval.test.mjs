import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gradeAssessment, parseAssessArgs, runAssessment } from "../eval/assess.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function assessmentFixture(root) {
  const fixture = path.join(root, "lookup-fixture");
  fs.mkdirSync(path.join(fixture, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "workspace", "lookup.mjs"), "export function lookup(items, key) { return items.find(([candidate]) => candidate === key); }\n");
  for (const file of ["evaluate.mjs", "gate.mjs", "control.patch"]) fs.writeFileSync(path.join(fixture, file), `HIDDEN ${file} ANSWER\n`);
  fs.writeFileSync(path.join(fixture, "manifest.json"), `${JSON.stringify({
    name: "secret-fixture-label",
    goal: "SECRET planted goal must not be shown to the assessor",
    metric: "total key comparisons (lower is better)", direction: "minimize",
    workspace: "workspace", scope_files: ["lookup.mjs"], candidate_program: "lookup.mjs",
    evaluator: "evaluate.mjs", gate: "gate.mjs", control_patch: "control.patch",
    verifier_inputs: ["evaluate.mjs", "gate.mjs", "control.patch"], evaluator_kind: "deterministic command",
    interpreter: "node", readiness: "ready", baseline_gate_passes: true,
    levers: [{ goal: "SECRET planted lever", scope_files: ["lookup.mjs"], metric: "total key comparisons", evaluator_kind: "command", readiness: "ready" }],
  }, null, 2)}\n`);
  return fixture;
}

test("assessment stays inert by default and requires all real-run budgets and paths", () => {
  assert.deepEqual(parseAssessArgs([]), { run: false, list: false, fixtures: null, model: null, globalAgentBudget: null, budgetFile: null, output: null });
  assert.throws(() => parseAssessArgs(["--run"]), /--model/);
  assert.throws(() => parseAssessArgs(["--run", "--model=test/model"]), /--global-agent-budget/);
  const cli = spawnSync(process.execPath, [path.join(REPO, "eval", "assess.mjs")], { cwd: REPO, encoding: "utf8", timeout: 10_000 });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /no model calls were made/);
});

test("grader reports structural and evidence-field hits separately without scoring semantic goals", () => {
  const manifest = { scope_files: ["lookup.mjs"], metric: "total key comparisons (lower is better)", direction: "minimize", evaluator_kind: "deterministic command", interpreter: "node", evaluator: "evaluate.mjs", gate: "gate.mjs" };
  const response = { levers: [{ goal: "Reduce repeated comparisons", scope_files: ["lookup.mjs"], metric: "total key comparisons (lower is better)", evaluator_kind: "command", readiness: "needs_setup" }] };
  const grade = gradeAssessment(response, manifest);
  assert.equal(grade.structurallyValid, true);
  assert.deepEqual(grade.top3Hits, { scope: true, metricLexical: true, direction: true, evaluatorKind: true, evaluatorReadiness: true, completeStructural: true });
  assert.equal(grade.semanticGoalCorrectness, "not_automatically_judged");
  assert.match(grade.metricMatchMethod, /lexical token overlap heuristic/);
  const python = gradeAssessment(response, { ...manifest, interpreter: "python", evaluator_kind: "timed Python command" });
  assert.equal(python.top3Hits.evaluatorKind, true, "the production contract uses evaluator_kind=command for Python too");
  const invalid = gradeAssessment({ levers: [{ ...response.levers[0], scope_files: ["../evaluate.mjs"] }] }, manifest);
  assert.equal(invalid.structurallyValid, false);
  assert.equal(invalid.top3Hits.scope, false);
  for (const malformed of [{ levers: [null] }, { levers: [{ ...response.levers[0], scope_files: [1] }] }]) {
    const malformedGrade = gradeAssessment(malformed, manifest);
    assert.equal(malformedGrade.structurallyValid, false);
    assert.ok(Object.values(malformedGrade.top3Hits).every((hit) => hit === false));
  }
});

test("assessment runs one shared-budgeted read-only agent per fixture with source-only context", async () => {
  const root = tempDir("dream-assess-fixtures-");
  const output = tempDir("dream-assess-output-");
  const shared = path.join(root, "global-budget.json");
  const captured = [];
  const calls = [];
  try {
    assessmentFixture(path.join(root, "fixtures"));
    const modelResponse = { levers: [{ goal: "Reduce key comparisons by indexing once", scope_files: ["lookup.mjs"],
      metric: "total key comparisons (lower is better)", evaluator_kind: "command", readiness: "needs_setup" }] };
    const report = await runAssessment({ run: true, model: "test/offline-fixture", globalAgentBudget: 2, budgetFile: shared,
      output, fixtureRoot: path.join(root, "fixtures"), packageRoot: REPO,
      runAgentImpl: async (request) => {
        calls.push(request);
        request.beforeSpawn();
        captured.push(request.prompt);
        const files = fs.readdirSync(request.cwd);
        assert.deepEqual(files, ["lookup.mjs"]);
        request.onOutput({ kind: "text", stream: "stdout", text: JSON.stringify(modelResponse) });
        return { ok: true, timedOut: false, spawnError: null, durationMs: 5, evidence: { usage: { total: 17 }, stopReasons: { stop: 1 } } };
      } });
    assert.equal(calls.length, 1, "one runner invocation for the one selected fixture");
    assert.equal(calls[0].timeoutMs, 8 * 60_000);
    assert.equal(calls[0].agent.model, "test/offline-fixture");
    assert.ok(calls[0].agent.args.includes("--tools"));
    assert.ok(calls[0].agent.args.includes("read,grep,find,ls"));
    assert.doesNotMatch(captured[0], /SECRET planted|HIDDEN evaluate\.mjs|control\.patch|manifest\.json/);
    assert.match(captured[0], /dream-rsi-assess/);
    assert.equal(report.assessments[0].grade.structurallyValid, true);
    assert.equal(report.assessments[0].grade.top3Hits.scope, true);
    assert.equal(report.assessments[0].grade.top3Hits.evaluatorReadiness, true);
    assert.equal(report.semanticGoalCorrectness, "not_automatically_judged");
    assert.deepEqual(JSON.parse(fs.readFileSync(shared, "utf8")), { version: 1, limit: 2, spent: 1 });
    assert.equal(fs.existsSync(path.join(output, "assessment.json")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(output, { recursive: true, force: true });
  }
});
