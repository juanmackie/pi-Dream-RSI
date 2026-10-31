import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeProject, mockPi } from "./fixtures.mjs";
import dreamRsi from "../extensions/pi-dream-rsi/index.ts";
import { statusAuto } from "../extensions/pi-dream-rsi/engine/auto.ts";

async function initializedAuto(project) {
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: project.projectDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Dream RSI Test"], { cwd: project.projectDir });
  execFileSync("git", ["config", "user.email", "dream-rsi-test@example.invalid"], { cwd: project.projectDir });
  execFileSync("git", ["add", "."], { cwd: project.projectDir });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: project.projectDir, stdio: "ignore" });
  const { pi, context, harness } = mockPi(); dreamRsi(pi); context.cwd = project.projectDir;
  await harness.handlers.get("session_start")({}, context);
  await harness.commands.get("dream-rsi").handler("auto --consent retry test", context);
  const result = await harness.tools.get("dream_rsi_auto_init").execute("init", {
    consent: true, goal: "Exercise transient retry control", metric: "constant", unit: "count", higherIsBetter: false,
    command: "node -e \"console.log(1)\"", checks: "node -e \"process.exit(0)\"", scope: ["src"],
    minimumGain: 1, maxExperiments: 4, maxConsecutiveDiscards: 3, providerCap: 10, branch: "dream-rsi/auto",
  }, undefined, undefined, context);
  assert.equal(result.details.ok, true, result.content[0].text);
  return { context, harness };
}

test("transient provider continuation is bounded to two retries and stops on the third failure", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { context, harness } = await initializedAuto(project);
  const onEnd = harness.handlers.get("agent_end");
  const beforeSettle = harness.handlers.get("agent_before_settle");
  for (const expectedRetries of [1, 2]) {
    await onEnd({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "HTTP 429 rate limit" }] }, context);
    const retry = await beforeSettle({ outcome: "error", entries: [] }, context);
    assert.equal(retry.continue, true);
    assert.match(retry.entries.at(-1).content, new RegExp(`failure ${expectedRetries} of 3`));
  }
  await onEnd({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "HTTP 503 overloaded" }] }, context);
  assert.equal(await beforeSettle({ outcome: "error", entries: [] }, context), undefined);
  assert.equal(statusAuto(project.projectDir).state, "stopped");
  assert.match(statusAuto(project.projectDir).next, /three transient provider failures/);
  const saved = JSON.parse(fs.readFileSync(path.join(project.projectDir, ".dream-rsi/auto/config.json"), "utf8"));
  assert.equal(saved.providerFailure, "transient");
  assert.equal(saved.providerTransientRetries, 3);
  assert.equal(saved.stopReason, "three transient provider failures");
  assert.equal(saved.providerError, undefined);
});

test("a successful provider turn clears the transient retry count", async (t) => {
  const project = makeProject(); t.after(project.cleanup);
  const { context, harness } = await initializedAuto(project);
  const onEnd = harness.handlers.get("agent_end");
  await onEnd({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "HTTP 503 overloaded" }] }, context);
  await onEnd({ messages: [{ role: "assistant", stopReason: "stop" }] }, context);
  assert.equal((await harness.handlers.get("agent_before_settle")({ outcome: "error", entries: [] }, context)), undefined);
  assert.equal(statusAuto(project.projectDir).state, "active");
});
