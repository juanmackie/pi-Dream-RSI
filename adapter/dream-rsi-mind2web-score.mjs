#!/usr/bin/env node
/** @fileoverview Runs and scores owned, pinned Mind2Web evaluation artifacts. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WORKSPACE = path.resolve(process.argv[2] || process.cwd());
const SCORE_PATH = path.join(WORKSPACE, 'eval', 'score.json');
const HARNESS_DIR = process.env.DREAM_RSI_HARNESS_DIR
  ? path.resolve(process.env.DREAM_RSI_HARNESS_DIR)
  : '';
const DATASET_DIR = process.env.DREAM_RSI_DATASET_DIR
  ? path.resolve(process.env.DREAM_RSI_DATASET_DIR)
  : '';
const CASES_PATH = process.env.DREAM_RSI_CASES_FILE
  ? path.resolve(process.env.DREAM_RSI_CASES_FILE)
  : '';
const REPEATS = 3;
const CASES_PER_REPEAT = 10;
const EXPECTED_MODEL = process.env.DREAM_RSI_EXPECTED_MODEL || '';
const EXPECTED_PROVIDER_HOST = process.env.DREAM_RSI_EXPECTED_PROVIDER_HOST || '';
const RUNNER = HARNESS_DIR ? path.join(HARNESS_DIR, 'scripts', 'mind2web-live.mjs') : '';
const BUILDER = HARNESS_DIR ? path.join(HARNESS_DIR, 'scripts', 'build-extension.mjs') : '';

function writeScore(score, failClass, extra = {}) {
  mkdirSync(path.dirname(SCORE_PATH), { recursive: true });
  writeFileSync(
    SCORE_PATH,
    `${JSON.stringify({ score, fail_class: failClass, valid: failClass === 'ok', ...extra })}\n`
  );
}

function fail(failClass) {
  writeScore(0, failClass);
  console.error(`Mind2Web evaluator failed: ${failClass}`);
  process.exitCode = 1;
}

async function runNode(script, args, env) {
  const result = await execFileAsync(process.execPath, [script, ...args], {
    cwd: HARNESS_DIR,
    env,
    windowsHide: true,
    timeout: 600_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return result.stdout;
}

function parseRunSummary(stdout, expectedOutput, casesHash, model) {
  const summaryLine = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  let summary;
  try {
    summary = JSON.parse(summaryLine);
  } catch {
    throw new Error('run_summary_invalid');
  }
  if (
    typeof summary?.runId !== 'string' ||
    !summary.runId ||
    path.resolve(summary.output || '') !== expectedOutput ||
    summary.caseManifestSha256 !== casesHash ||
    summary.modelId !== model ||
    summary.temperature !== 0 ||
    summary.requestedScoredActions !== CASES_PER_REPEAT ||
    summary.total !== CASES_PER_REPEAT ||
    summary.runAttempts !== CASES_PER_REPEAT ||
    summary.attempted !== CASES_PER_REPEAT ||
    summary.errors !== 0 ||
    summary.timeouts !== 0
  ) {
    throw new Error('run_summary_invalid');
  }
  return summary.runId;
}

function scoreRuns(caseManifest, casesHash, outputPaths, expectedRunIds, model, providerHost) {
  let totalMatches = 0;
  const repeatScores = [];
  const runIds = new Set();
  for (let repeat = 0; repeat < outputPaths.length; repeat += 1) {
    const outputPath = outputPaths[repeat];
    let rows;
    try {
      rows = readFileSync(outputPath, 'utf8')
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      throw new Error('row_count_invalid');
    }
    if (rows.length !== CASES_PER_REPEAT) throw new Error('row_count_invalid');
    let matches = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const expected = caseManifest.cases[index];
      if (
        !row ||
        row.runId !== expectedRunIds[repeat] ||
        row.caseManifestSha256 !== casesHash ||
        row.modelId !== model ||
        row.temperature !== 0 ||
        row.dryRun !== true ||
        expected.taskId !== `${caseManifest.split}:${row.taskId}` ||
        row.actionId !== expected.actionId ||
        typeof row.metrics?.exactMatch !== 'boolean' ||
        !Number.isInteger(row.diagnostics?.providerCallCount) ||
        row.diagnostics.providerCallCount < 1
      ) {
        throw new Error('row_contract_invalid');
      }
      runIds.add(row.runId);
      if (row.metrics.exactMatch) matches += 1;
    }
    repeatScores.push(matches / CASES_PER_REPEAT);
    totalMatches += matches;
  }
  if (
    outputPaths.length !== REPEATS ||
    expectedRunIds.length !== REPEATS ||
    runIds.size !== REPEATS
  ) {
    throw new Error('run_identity_invalid');
  }
  return {
    score: totalMatches / (REPEATS * CASES_PER_REPEAT),
    fail_class: 'ok',
    valid: true,
    exact_matches: totalMatches,
    model_id: model,
    case_manifest_sha256: casesHash,
    run_ids: expectedRunIds,
    temperature: 0,
    provider_host: providerHost,
    source_artifacts: outputPaths,
    evaluated_actions: REPEATS * CASES_PER_REPEAT,
    repeats: repeatScores,
    cases_per_repeat: CASES_PER_REPEAT,
  };
}

function classifyFailure(error) {
  const text = String(error?.stderr || error?.message || '');
  if (/(?:HTTP|status)[^0-9]*401|unauthorized/iu.test(text)) return 'provider_auth_failed';
  if (/(?:HTTP|status)[^0-9]*429|rate.?limit/iu.test(text)) return 'provider_rate_limited';
  if (/timeout|ETIMEDOUT/iu.test(text)) return 'harness_timeout';
  if (
    [
      'row_count_invalid',
      'row_contract_invalid',
      'run_identity_invalid',
      'run_summary_invalid',
    ].includes(error?.message)
  ) {
    return 'score_artifact_invalid';
  }
  return 'harness_run_failed';
}

async function main() {
  let runDir;
  let keepRunDir = false;
  try {
    mkdirSync(path.dirname(SCORE_PATH), { recursive: true });
    rmSync(SCORE_PATH, { force: true });
    writeScore(0, 'evaluator_setup_failed');
    if (
      !HARNESS_DIR ||
      !DATASET_DIR ||
      !CASES_PATH ||
      !EXPECTED_MODEL ||
      !EXPECTED_PROVIDER_HOST
    ) {
      fail('adapter_configuration_missing');
      return;
    }
    process.loadEnvFile(path.join(HARNESS_DIR, '.env'));
    const model = process.env.LLM_MODEL;
    const providerHost = new URL(process.env.LLM_BASE_URL || '').host;
    if (!process.env.LLM_API_KEY || !model || !providerHost) {
      fail('provider_configuration_missing');
      return;
    }
    if (model !== EXPECTED_MODEL || providerHost !== EXPECTED_PROVIDER_HOST) {
      fail('provider_identity_mismatch');
      return;
    }
    if (
      !statSync(DATASET_DIR).isDirectory() ||
      !statSync(CASES_PATH).isFile() ||
      !statSync(RUNNER).isFile() ||
      !statSync(BUILDER).isFile()
    ) {
      fail('evaluation_input_missing');
      return;
    }

    const caseBytes = readFileSync(CASES_PATH);
    const caseManifest = JSON.parse(caseBytes.toString('utf8'));
    if (
      caseManifest?.schemaVersion !== 1 ||
      caseManifest?.split !== 'test_domain' ||
      caseManifest?.limit !== CASES_PER_REPEAT ||
      !Array.isArray(caseManifest.cases) ||
      caseManifest.cases.length !== CASES_PER_REPEAT ||
      caseManifest.cases.some(
        (entry) =>
          typeof entry?.taskId !== 'string' ||
          !entry.taskId.startsWith('test_domain:') ||
          typeof entry?.actionId !== 'string' ||
          !entry.actionId
      ) ||
      new Set(caseManifest.cases.map((entry) => `${entry.taskId}\n${entry.actionId}`)).size !==
        CASES_PER_REPEAT
    ) {
      fail('case_manifest_invalid');
      return;
    }

    const casesHash = createHash('sha256').update(caseBytes).digest('hex');
    const env = { ...process.env, PROMPT_PAUL_EXTENSION_ROOT: WORKSPACE };
    try {
      await runNode(BUILDER, [], env);
    } catch {
      fail('extension_build_failed');
      return;
    }

    runDir = mkdtempSync(path.join(WORKSPACE, 'eval', 'mind2web-run-'));
    const outputPaths = Array.from({ length: REPEATS }, (_, index) =>
      path.join(runDir, `repeat-${index + 1}.jsonl`)
    );
    const expectedRunIds = [];
    for (const output of outputPaths) {
      const args = [
        '--data-dir',
        DATASET_DIR,
        '--split',
        'test_domain',
        '--run',
        '--limit',
        String(CASES_PER_REPEAT),
        '--temperature',
        '0',
        '--cases-file',
        CASES_PATH,
        '--extension-dir',
        path.join(WORKSPACE, 'dist-eval'),
        '--output',
        output,
      ];
      const stdout = await runNode(RUNNER, args, env);
      expectedRunIds.push(parseRunSummary(stdout, output, casesHash, model));
    }

    writeScore(0, 'score_artifact_invalid');
    try {
      const result = scoreRuns(
        caseManifest,
        casesHash,
        outputPaths,
        expectedRunIds,
        model,
        providerHost
      );
      for (const output of outputPaths) {
        rmSync(output.replace(/\.jsonl$/iu, '.errors.jsonl'), { force: true });
        rmSync(output.replace(/\.jsonl$/iu, '.traces.jsonl'), { force: true });
      }
      writeFileSync(SCORE_PATH, `${JSON.stringify(result)}\n`);
      keepRunDir = true;
    } catch (error) {
      fail(classifyFailure(error));
    }
  } catch (error) {
    fail(error?.code === 'ENOENT' ? 'evaluation_input_missing' : classifyFailure(error));
  } finally {
    if (runDir && !keepRunDir) rmSync(runDir, { recursive: true, force: true });
  }
}

await main();
