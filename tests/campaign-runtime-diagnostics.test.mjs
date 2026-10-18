import assert from "node:assert/strict";
import { test } from "node:test";
import { jump } from "./fixtures.mjs";

const { campaignRuntimeDiagnostics } = await jump("engine/campaign.ts");

test("runtime diagnostics identify the shipped campaign engine", () => {
  const runtime = campaignRuntimeDiagnostics();
  assert.match(runtime.campaignModule.replaceAll("\\", "/"), /extensions\/pi-dream-rsi\/engine\/campaign\.ts$/);
  assert.equal(runtime.defaultEvaluatorTimeoutMs, 300_000);
});