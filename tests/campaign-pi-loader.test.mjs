import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { REPO } from "./fixtures.mjs";

const smokeScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "campaign-pi-loader-smoke.mjs");
const execFileAsync = promisify(execFile);

test("Pi loads the v3 loop and status tool without the removed improve tool", async () => {
  const isolatedAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-pi-loader-"));
  try {
    const child = await execFileAsync(process.execPath, [smokeScript], {
      cwd: REPO, encoding: "utf8", timeout: 90_000, windowsHide: true,
      env: { ...process.env, PI_CODING_AGENT_DIR: isolatedAgentDir, JITI_FS_CACHE: "false" },
    });
    const smoke = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1));
    assert.deepEqual(smoke.tools, ["dream_rsi_loop", "dream_rsi_signals"]);
    assert.match(smoke.status, /No loop state yet/);
    assert.equal(smoke.campaign, null);
  } catch (error) {
    assert.fail(`Pi loader smoke failed (${error.code ?? error.signal ?? "unknown"}):\n${error.stderr ?? ""}\n${error.stdout ?? ""}`);
  } finally {
    fs.rmSync(isolatedAgentDir, { recursive: true, force: true });
  }
});