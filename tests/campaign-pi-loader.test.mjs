import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { EXT, REPO } from "./fixtures.mjs";

const smokeScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "campaign-pi-loader-smoke.mjs");
const execFileAsync = promisify(execFile);

test("Pi's extension loader reports the loaded source and preserves the requested evaluator timeout", async () => {
  const isolatedAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-pi-loader-"));
  try {
    let child;
    try {
      child = await execFileAsync(process.execPath, [smokeScript], {
        cwd: REPO,
        encoding: "utf8",
        timeout: 90_000,
        windowsHide: true,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: isolatedAgentDir,
          JITI_FS_CACHE: "false",
        },
      });
    } catch (error) {
      assert.fail(`Pi loader smoke failed (${error.code ?? error.signal ?? "unknown"}):\n${error.stderr ?? ""}\n${error.stdout ?? ""}`);
    }
    const output = child.stdout.trim().split(/\r?\n/).at(-1);
    const smoke = JSON.parse(output);
    const expectedPackageDir = path.resolve(EXT, "..", "..");

    assert.equal(smoke.status.campaign, null);
    assert.equal(smoke.status.runtime.extensionDir, EXT);
    assert.equal(smoke.status.runtime.packageDir, expectedPackageDir);
    assert.equal(smoke.status.runtime.defaultEvaluatorTimeoutMs, 300_000);
    assert.match(smoke.status.runtime.campaignModule.replaceAll("\\", "/"), /extensions\/pi-dream-rsi\/engine\/campaign\.ts$/);
    assert.equal(smoke.persistedTimeoutMs, 600_000);
    assert.equal(smoke.start.campaign.effectiveEvaluatorTimeoutMs, 600_000);
    assert.ok(smoke.baselineEvaluatorRuns >= 5, "the startup snapshot includes the completed five-score baseline");
    assert.equal(smoke.baselineScoreCount, 5);
    assert.equal(smoke.baselineRuntime.defaultEvaluatorTimeoutMs, 300_000);
    assert.ok(smoke.start.campaign.evaluatorRuns >= 5, "baseline and subsequent verification scores are recorded");
    assert.ok(smoke.start.campaign.agentStarts >= 1, "the smoke runs local campaign agents after the baseline");
    assert.equal(smoke.agentStartsAtBaseline, 0, "baseline scoring begins before any agent runs");
  } finally {
    fs.rmSync(isolatedAgentDir, { recursive: true, force: true });
  }
});
