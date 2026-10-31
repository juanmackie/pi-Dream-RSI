/**
 * Magnitude estimation.
 *
 * The estimator orders search; it never decides promotion. These tests pin the
 * conservative rules and the log-utility ordering that lets a high-magnitude,
 * low-confidence bet outrank a small local gain.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  campaignTypePriority, estimateMagnitude, estimateScopeMagnitude, magnitudeLabel, magnitudeUtility,
} from "../extensions/pi-dream-rsi/engine/magnitude.ts";

test("no structural signal falls back to a local hill climb", () => {
  const magnitude = estimateMagnitude({});
  assert.equal(magnitude.campaignType, "local-hill");
  assert.equal(magnitude.expectedGainMultiplier, 1.15);
  assert.equal(magnitude.confidence, 0.7);
  assert.match(magnitude.rationale[0], /no structural magnitude signal/i);
});

test("nested loops are an algorithmic bet, and a linear scan inside them raises the estimate", () => {
  const nested = estimateMagnitude({ nestedLoops: true });
  assert.equal(nested.campaignType, "algorithmic");
  assert.equal(nested.expectedGainMultiplier, 6);
  assert.equal(nested.confidence, 0.35);

  const quadratic = estimateMagnitude({ nestedLoops: true, linearScanInLoop: true });
  assert.equal(quadratic.campaignType, "algorithmic");
  assert.equal(quadratic.expectedGainMultiplier, 8, "a linear scan inside a loop is a stronger algorithmic signal");
});

test("blocking I/O and serial awaits are systemic bets", () => {
  assert.equal(estimateMagnitude({ syncIoInLoop: true }).expectedGainMultiplier, 3);
  assert.equal(estimateMagnitude({ serialAwait: true }).expectedGainMultiplier, 2.2);
  const combined = estimateMagnitude({ syncIoInLoop: true, serialAwait: true });
  assert.equal(combined.campaignType, "systemic");
  assert.equal(combined.expectedGainMultiplier, 3.5);
  assert.match(combined.rationale[0], /blocking I\/O inside a loop and sequential awaits/i);
});

test("dependency lag and structural smells stay smaller, conservative bets", () => {
  const dependency = estimateMagnitude({ dependencyMajorLag: 2 });
  assert.equal(dependency.campaignType, "dependency");
  assert.equal(dependency.expectedGainMultiplier, 2);
  assert.equal(dependency.confidence, 0.4);

  const structural = estimateMagnitude({ godFile: true });
  assert.equal(structural.campaignType, "structural");
  assert.equal(structural.expectedGainMultiplier, 1.4);
  assert.equal(structural.confidence, 0.55);
});

test("the best utility wins, and the other signals are named rather than hidden", () => {
  const magnitude = estimateMagnitude({ nestedLoops: true, syncIoInLoop: true, godFile: true });
  assert.equal(magnitude.campaignType, "algorithmic", "a 6x algorithmic bet outranks a 3x systemic and a 1.4x structural bet");
  assert.ok(magnitude.rationale.some((line) => /other signals present: systemic, structural/.test(line)));
});

test("log-utility ordering prefers a large uncertain bet over a small confident one", () => {
  const local = estimateMagnitude({});
  const algorithmic = estimateMagnitude({ nestedLoops: true });
  assert.ok(magnitudeUtility(algorithmic) > magnitudeUtility(local));
  assert.equal(magnitudeUtility({ campaignType: "local-hill", expectedGainMultiplier: 1, confidence: 1, rationale: [] }), 0);
  assert.equal(magnitudeUtility({ campaignType: "algorithmic", expectedGainMultiplier: 8, confidence: 2, rationale: [] }),
    magnitudeUtility({ campaignType: "algorithmic", expectedGainMultiplier: 8, confidence: 1, rationale: [] }),
    "confidence is clamped before it is used");
});

test("scope estimates merge repeated evidence with a capped bonus", () => {
  const empty = estimateScopeMagnitude([]);
  assert.equal(empty.campaignType, "local-hill");

  const merged = estimateScopeMagnitude([
    { path: "src/a.mjs", signals: { nestedLoops: true } },
    { path: "src/b.mjs", signals: { nestedLoops: true } },
    { path: "src/c.mjs", signals: { godFile: true } },
  ]);
  assert.equal(merged.campaignType, "algorithmic");
  assert.equal(merged.expectedGainMultiplier, 6);
  assert.ok(merged.confidence > 0.35 && merged.confidence <= 0.85, "repeated evidence raises confidence, but only slightly");
  assert.ok(merged.rationale.some((line) => /supporting scope: src\/a\.mjs, src\/b\.mjs/.test(line)));
});

test("campaign types have a stable ambition order and a readable label", () => {
  assert.ok(campaignTypePriority("local-hill") < campaignTypePriority("structural"));
  assert.ok(campaignTypePriority("structural") < campaignTypePriority("dependency"));
  assert.ok(campaignTypePriority("dependency") < campaignTypePriority("systemic"));
  assert.ok(campaignTypePriority("systemic") < campaignTypePriority("algorithmic"));
  assert.equal(magnitudeLabel({ campaignType: "algorithmic", expectedGainMultiplier: 3.5, confidence: 0.45, rationale: [] }),
    "algorithmic ~3.5x best case at 45% confidence");
  assert.equal(magnitudeLabel({ campaignType: "algorithmic", expectedGainMultiplier: 12.4, confidence: 0.4, rationale: [] }),
    "algorithmic ~12x best case at 40% confidence");
});
