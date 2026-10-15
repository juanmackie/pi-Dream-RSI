import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const ADAPTER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'adapter',
  'dream-rsi-mind2web-score.mjs'
);
const model = 'mistral-small-2603';
const providerHost = 'api.mistral.ai';

const fakeRunner = `
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const value = (name) => process.argv[process.argv.indexOf(name) + 1];
const has = (name) => process.argv.includes(name);
const output = path.resolve(value('--output'));
const casesPath = path.resolve(value('--cases-file'));
const extensionDir = path.resolve(value('--extension-dir'));
if (
  !has('--run') || has('--prepare-cases') ||
  value('--split') !== 'test_domain' ||
  value('--limit') !== '10' ||
  value('--temperature') !== '0' ||
  casesPath !== path.resolve(process.env.DREAM_RSI_CASES_FILE) ||
  extensionDir !== path.join(process.env.PROMPT_PAUL_EXTENSION_ROOT, 'dist-eval') ||
  !output.startsWith(path.join(process.env.PROMPT_PAUL_EXTENSION_ROOT, 'eval', 'mind2web-run-'))
) {
  throw new Error('adapter did not invoke the pinned explicit-run contract');
}
const manifestBytes = readFileSync(casesPath);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const caseManifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
const repeat = Number(path.basename(output).match(/repeat-(\\d+)/)[1]);
const runId = \`owned-run-\${repeat}\`;
const mode = process.env.FAKE_EVAL_MODE;
const expectedMatches = [4, 2, 3][repeat - 1];

if (mode !== 'no-output') {
  const rowRunId = mode === 'unrelated' ? 'old-unrelated-run' : runId;
  const rowModel = mode === 'wrong-model' ? 'unapproved-model' : process.env.LLM_MODEL;
  const rowManifestHash = mode === 'wrong-manifest' ? 'wrong-manifest-hash' : caseManifestSha256;
  const rows = manifest.cases.map((entry, index) => ({
    runId: rowRunId,
    caseManifestSha256: rowManifestHash,
    modelId: rowModel,
    temperature: 0,
    dryRun: true,
    taskId: entry.taskId.slice('test_domain:'.length),
    actionId: entry.actionId,
    diagnostics: { providerCallCount: mode === 'provider-free' ? 0 : 1 },
    metrics: { exactMatch: index < expectedMatches },
  }));
  writeFileSync(output, rows.map((row) => JSON.stringify(row)).join('\\n') + '\\n', { flag: 'wx' });
}

console.log(JSON.stringify({
  runId,
  output: mode === 'stale-summary' ? output + '.stale' : output,
  caseManifestSha256,
  modelId: process.env.LLM_MODEL,
  temperature: 0,
  requestedScoredActions: 10,
  total: 10,
  runAttempts: 10,
  attempted: 10,
  errors: 0,
  timeouts: 0,
}));
`;

async function fixture(t, mode = 'valid') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dream-rsi-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = path.join(root, 'harness');
  const workspace = path.join(root, 'workspace');
  const dataset = path.join(root, 'dataset');
  const casesPath = path.join(root, 'cases.json');
  const scripts = path.join(harness, 'scripts');
  await Promise.all([
    mkdir(scripts, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(dataset, { recursive: true }),
  ]);
  await writeFile(path.join(harness, '.env'), `LLM_API_KEY=test-only\nLLM_MODEL=${model}\nLLM_BASE_URL=https://${providerHost}/v1\n`);
  await writeFile(
    path.join(scripts, 'build-extension.mjs'),
    `if (process.env.PROMPT_PAUL_EXTENSION_ROOT !== process.env.DREAM_RSI_EXPECTED_EXTENSION_ROOT) process.exit(2);\n`
  );
  await writeFile(path.join(scripts, 'mind2web-live.mjs'), fakeRunner);
  const cases = Array.from({ length: 10 }, (_, index) => ({
    taskId: `test_domain:task-${index}`,
    actionId: `action-${index}`,
  }));
  await writeFile(
    casesPath,
    JSON.stringify({ schemaVersion: 1, split: 'test_domain', limit: 10, cases })
  );
  return {
    workspace,
    harness,
    dataset,
    casesPath,
    env: {
      ...process.env,
      DREAM_RSI_HARNESS_DIR: harness,
      DREAM_RSI_DATASET_DIR: dataset,
      DREAM_RSI_CASES_FILE: casesPath,
      DREAM_RSI_EXPECTED_MODEL: model,
      DREAM_RSI_EXPECTED_PROVIDER_HOST: providerHost,
      DREAM_RSI_EXPECTED_EXTENSION_ROOT: workspace,
      LLM_API_KEY: 'test-only',
      LLM_MODEL: model,
      LLM_BASE_URL: `https://${providerHost}/v1`,
      FAKE_EVAL_MODE: mode,
    },
  };
}

async function runAdapter(fixtureData) {
  try {
    await execFileAsync(process.execPath, [ADAPTER, fixtureData.workspace], {
      env: fixtureData.env,
      timeout: 30_000,
    });
    return { exitCode: 0 };
  } catch (error) {
    return { exitCode: error.code, stderr: error.stderr };
  }
}

async function readScore(workspace) {
  return JSON.parse(await readFile(path.join(workspace, 'eval', 'score.json'), 'utf8'));
}

test('scores only rows owned by each explicit run summary', async (t) => {
  const data = await fixture(t);
  const result = await runAdapter(data);
  assert.equal(result.exitCode, 0);
  const score = await readScore(data.workspace);
  assert.equal(score.valid, true);
  assert.equal(score.score, 0.3);
  assert.equal(score.exact_matches, 9);
  assert.deepEqual(score.repeats, [0.4, 0.2, 0.3]);
  assert.equal(score.evaluated_actions, 30);
  assert.equal(score.case_manifest_sha256, createHash('sha256').update(await readFile(data.casesPath)).digest('hex'));
  assert.deepEqual(score.run_ids, ['owned-run-1', 'owned-run-2', 'owned-run-3']);
  assert.equal(score.temperature, 0);
  assert.equal(score.provider_host, providerHost);
  assert.equal(score.source_artifacts.length, 3);
  for (const [index, source] of score.source_artifacts.entries()) {
    const rows = (await readFile(source, 'utf8'))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 10);
    assert.ok(rows.every((row) => row.runId === score.run_ids[index]));
  }
});

test('rejects unrelated rows even when they occupy the fresh output path', async (t) => {
  const data = await fixture(t, 'unrelated');
  const result = await runAdapter(data);
  assert.notEqual(result.exitCode, 0);
  const score = await readScore(data.workspace);
  assert.equal(score.valid, false);
  assert.equal(score.fail_class, 'score_artifact_invalid');
});

test('rejects preparation-only rows with zero provider calls', async (t) => {
  const data = await fixture(t, 'provider-free');
  const result = await runAdapter(data);
  assert.notEqual(result.exitCode, 0);
  const score = await readScore(data.workspace);
  assert.equal(score.valid, false);
  assert.equal(score.fail_class, 'score_artifact_invalid');
});

test('rejects rows scored with a model outside the configured pin', async (t) => {
  const data = await fixture(t, 'wrong-model');
  const result = await runAdapter(data);
  assert.notEqual(result.exitCode, 0);
  const score = await readScore(data.workspace);
  assert.equal(score.valid, false);
  assert.equal(score.fail_class, 'score_artifact_invalid');
});

test('rejects rows scored against a different pinned manifest', async (t) => {
  const data = await fixture(t, 'wrong-manifest');
  const result = await runAdapter(data);
  assert.notEqual(result.exitCode, 0);
  const score = await readScore(data.workspace);
  assert.equal(score.valid, false);
  assert.equal(score.fail_class, 'score_artifact_invalid');
});

test('rejects a summary for a different output and ignores stale harness artifacts', async (t) => {
  const data = await fixture(t, 'stale-summary');
  const staleArtifacts = path.join(data.harness, 'artifacts', 'runs');
  await mkdir(staleArtifacts, { recursive: true });
  await writeFile(path.join(staleArtifacts, 'old-perfect.jsonl'), `${JSON.stringify({ metrics: { exactMatch: true } })}\n`);
  const result = await runAdapter(data);
  assert.notEqual(result.exitCode, 0);
  const score = await readScore(data.workspace);
  assert.equal(score.valid, false);
  assert.equal(score.fail_class, 'score_artifact_invalid');
});

test('rejects successful commands without output even when stale perfect output exists', async (t) => {
  const data = await fixture(t, 'no-output');
  const staleArtifacts = path.join(data.harness, 'artifacts', 'runs');
  await mkdir(staleArtifacts, { recursive: true });
  await writeFile(path.join(staleArtifacts, 'old-perfect.jsonl'), `${JSON.stringify({ metrics: { exactMatch: true } })}\n`);
  const result = await runAdapter(data);
  assert.notEqual(result.exitCode, 0);
  const score = await readScore(data.workspace);
  assert.equal(score.valid, false);
  assert.equal(score.fail_class, 'score_artifact_invalid');
});

test('clears a previous valid score and writes invalid output for missing configuration', async (t) => {
  const data = await fixture(t);
  const scorePath = path.join(data.workspace, 'eval', 'score.json');
  await mkdir(path.dirname(scorePath), { recursive: true });
  await writeFile(scorePath, JSON.stringify({ valid: true, score: 1 }));
  for (const key of [
    'DREAM_RSI_HARNESS_DIR',
    'DREAM_RSI_DATASET_DIR',
    'DREAM_RSI_CASES_FILE',
    'DREAM_RSI_EXPECTED_MODEL',
    'DREAM_RSI_EXPECTED_PROVIDER_HOST',
    'DREAM_RSI_EXPECTED_EXTENSION_ROOT',
  ]) {
    delete data.env[key];
  }
  const result = await runAdapter(data);
  assert.notEqual(result.exitCode, 0);
  const score = await readScore(data.workspace);
  assert.equal(score.valid, false);
  assert.equal(score.fail_class, 'adapter_configuration_missing');
});
