import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { jump } from "./fixtures.mjs";

test("paired verification screens once, then confirms twice and requires valid before and after", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-pairs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seed = path.join(root, "seed");
  const target = path.join(root, "target");
  const candidate = path.join(root, "candidate");
  for (const dir of [seed, target, candidate]) fs.mkdirSync(dir, { recursive: true });
  for (const dir of [seed, target, candidate]) fs.writeFileSync(path.join(dir, "value.txt"), "0\n");
  fs.writeFileSync(path.join(candidate, "value.txt"), "1\n");
  const scorer = path.join(root, "score.mjs");
  const counter = path.join(root, "counter.txt");
  fs.writeFileSync(scorer, `import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";\nconst index = existsSync(${JSON.stringify(counter)}) ? Number(readFileSync(${JSON.stringify(counter)}, "utf8")) : 0;\nwriteFileSync(${JSON.stringify(counter)}, String(index + 1));\nconst offset = [0,0,10,10,0,98][index];\nconst raw = offset + 2 * Number(readFileSync("value.txt", "utf8"));\nmkdirSync("eval", {recursive:true});\nwriteFileSync("eval/score.json", JSON.stringify({score:raw,raw_score:raw,valid:true,fail_class:"ok",error:null}));\n`);
  const { buildCandidatePatch, verifyCandidatePatch } = await jump("engine/campaign-patch.ts");
  const patch = buildCandidatePatch({ cycleSeedRoot: seed, targetRoot: target, candidateRoot: candidate });
  const starts = [];
  const task = { workspace: ".", score_program: `node "${scorer}"`, score_path: "eval/score.json", score_field: "score", valid_field: "valid", fail_class_field: "fail_class", error_field: "error", higher_is_better: true, evaluator_timeout_ms: 5000, copy_exclude: [] };
  const result = await verifyCandidatePatch({
    dreamRoot: path.join(root, "dream"), projectDir: target, task, patch, evidenceDir: path.join(root, "evidence"),
    repeats: 3, minimumGain: 0.5, requireValidBeforeAfter: true,
    beforeSpawn: (key) => starts.push(key),
  });
  assert.equal(result.pairs.length, 3);
  assert.equal(starts.length, 6);
  assert.deepEqual(result.pairs.map((pair) => pair.before.score), [0, 10, 0]);
  assert.deepEqual(result.pairs.map((pair) => pair.after.score), [2, 12, 100]);
  assert.equal(result.medianPairedGain, 2);
  assert.equal(result.medianAfter, 12);
  assert.equal(result.medianAfterRaw, 12);
  assert.equal(result.after.score, 12);
  assert.equal(result.improved, true);
  assert.ok(starts.every((key) => key.endsWith(":pair0") || key.endsWith(":pair1") || key.endsWith(":pair2")));
});

test("candidate confirmation persists complete pairs and resumes without repeating them", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-resumable-pairs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seed = path.join(root, "seed"), target = path.join(root, "target"), candidate = path.join(root, "candidate");
  for (const dir of [seed, target, candidate]) fs.mkdirSync(dir, { recursive: true });
  for (const dir of [seed, target, candidate]) fs.writeFileSync(path.join(dir, "value.txt"), "0\n");
  fs.writeFileSync(path.join(candidate, "value.txt"), "1\n");
  const scorer = path.join(root, "score.mjs"), counter = path.join(root, "counter.txt");
  fs.writeFileSync(scorer, `import {readFileSync,writeFileSync,mkdirSync,existsSync} from "node:fs"; const n=existsSync(${JSON.stringify(counter)})?Number(readFileSync(${JSON.stringify(counter)},"utf8")):0; writeFileSync(${JSON.stringify(counter)},String(n+1)); const raw=[10,10.1,9.9,10.2,9.8][n%5]+0.01*Number(readFileSync("value.txt","utf8")); mkdirSync("eval",{recursive:true}); writeFileSync("eval/score.json",JSON.stringify({score:raw,raw_score:raw,valid:true,fail_class:"ok"}));`);
  const { buildCandidatePatch, verifyCandidatePatch } = await jump("engine/campaign-patch.ts");
  const { planTest } = await jump("engine/measure.ts");
  const patch = buildCandidatePatch({ cycleSeedRoot: seed, targetRoot: target, candidateRoot: candidate });
  const task = { workspace: ".", score_program: `node "${scorer}"`, score_path: "eval/score.json", score_field: "score", valid_field: "valid", fail_class_field: "fail_class", error_field: "error", higher_is_better: true, evaluator_timeout_ms: 5000, copy_exclude: [] };
  const baseline = [10, 10.1, 9.9, 10.2, 9.8];
  const measurementPlan = planTest({ baseline, higherIsBetter: true, threshold: 0, maxCycles: 5, maxPairs: 8 });
  const options = { dreamRoot: path.join(root, "dream"), projectDir: target, task, patch, evidenceDir: path.join(root, "evidence"),
    measurementPlan, baselineReadings: baseline, confirmationIdentity: "fixed-verifier-target-patch", requireValidBeforeAfter: true };
  let interruptedStarts = 0;
  await assert.rejects(verifyCandidatePatch({ ...options, maxPairsToRun: 2, beforeSpawn: () => { if (++interruptedStarts === 2) throw new Error("simulated interruption"); } }), /simulated interruption/);
  assert.equal(Number(fs.readFileSync(counter, "utf8")), 1, "first completed reading is persisted before the next evaluator starts");
  const first = await verifyCandidatePatch({ ...options, maxPairsToRun: 2 });
  assert.equal(Number(fs.readFileSync(counter, "utf8")), 4, "resume reuses the saved reading and runs only the remaining three");
  assert.equal(first.measurementDecision, "continue");
  assert.equal(first.pairs.length, 2);
  const afterFirst = Number(fs.readFileSync(counter, "utf8"));
  const resumed = await verifyCandidatePatch({ ...options, maxPairsToRun: 4 });
  assert.equal(resumed.measurementDecision, "continue");
  assert.equal(resumed.pairs.length, 4);
  assert.equal(resumed.pairs[1].before.raw_score, 10.2, "odd saved pairs restore the before reading from their second ABBA position");
  assert.equal(resumed.pairs[1].after.raw_score, 9.91, "odd saved pairs restore the after reading from their first ABBA position");
  assert.equal(Number(fs.readFileSync(counter, "utf8")) - afterFirst, 4, "only the two new before/after pairs are measured on resume");
  const confirmationPath = path.join(options.evidenceDir, "confirmation.json");
  const corrupted = JSON.parse(fs.readFileSync(confirmationPath, "utf8"));
  corrupted.pairs[0].measurement.gain += 5;
  fs.writeFileSync(confirmationPath, JSON.stringify(corrupted));
  const beforeRevalidation = Number(fs.readFileSync(counter, "utf8"));
  const revalidated = await verifyCandidatePatch({ ...options, maxPairsToRun: 4 });
  assert.equal(revalidated.pairs.length, 2, "the invalid cache is discarded and the fresh confirmation may stop at its first decisive look");
  assert.equal(Number(fs.readFileSync(counter, "utf8")) - beforeRevalidation, 4, "only fresh before/after readings from the decisive look are used after cache invalidation");
  assert.ok(revalidated.pairs.every((pair) => Math.abs(pair.gain - (pair.after.raw_score - pair.before.raw_score)) < 1e-12), "the corrupt saved gain is not reused");
});

test("lower-is-better verification preserves the median raw after score", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-lower-pairs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seed = path.join(root, "seed");
  const target = path.join(root, "target");
  const candidate = path.join(root, "candidate");
  for (const dir of [seed, target, candidate]) fs.mkdirSync(dir, { recursive: true });
  for (const dir of [seed, target, candidate]) fs.writeFileSync(path.join(dir, "value.txt"), "0\n");
  fs.writeFileSync(path.join(candidate, "value.txt"), "1\n");
  const scorer = path.join(root, "score.mjs");
  const counter = path.join(root, "counter.txt");
  fs.writeFileSync(scorer, `import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";\nconst index = existsSync(${JSON.stringify(counter)}) ? Number(readFileSync(${JSON.stringify(counter)}, "utf8")) : 0;\nwriteFileSync(${JSON.stringify(counter)}, String(index + 1));\nconst raw = [10,8,12,10,14,12][index];\nmkdirSync("eval", {recursive:true});\nwriteFileSync("eval/score.json", JSON.stringify({score:raw,valid:true,fail_class:"ok",error:null}));\n`);
  const { buildCandidatePatch, verifyCandidatePatch } = await jump("engine/campaign-patch.ts");
  const patch = buildCandidatePatch({ cycleSeedRoot: seed, targetRoot: target, candidateRoot: candidate });
  const task = { workspace: ".", score_program: `node "${scorer}"`, score_path: "eval/score.json", score_field: "score", valid_field: "valid", fail_class_field: "fail_class", error_field: "error", higher_is_better: false, evaluator_timeout_ms: 5000, copy_exclude: [] };
  const result = await verifyCandidatePatch({ dreamRoot: path.join(root, "dream"), projectDir: target, task, patch, evidenceDir: path.join(root, "evidence"), repeats: 3, minimumGain: 0, requireValidBeforeAfter: true });
  assert.equal(result.medianPairedGain, 2);
  assert.equal(result.medianAfter, -10);
  assert.equal(result.medianAfterRaw, 10);
  assert.equal(result.after.raw_score, 10);
  assert.equal(result.improved, true);
});

test("a valid low-gain confirmation does not veto the median of three pairs", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-pair-screen-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seed = path.join(root, "seed");
  const target = path.join(root, "target");
  const candidate = path.join(root, "candidate");
  for (const dir of [seed, target, candidate]) fs.mkdirSync(dir, { recursive: true });
  for (const dir of [seed, target, candidate]) fs.writeFileSync(path.join(dir, "value.txt"), "0\n");
  fs.writeFileSync(path.join(candidate, "value.txt"), "1\n");
  const scorer = path.join(root, "score.mjs");
  const counter = path.join(root, "counter.txt");
  fs.writeFileSync(scorer, `import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";\nconst index = existsSync(${JSON.stringify(counter)}) ? Number(readFileSync(${JSON.stringify(counter)}, "utf8")) : 0;\nwriteFileSync(${JSON.stringify(counter)}, String(index + 1));\nconst pair = Math.floor(index / 2);\nconst raw = pair === 1 ? 0 : 4 * Number(readFileSync("value.txt", "utf8"));\nmkdirSync("eval", {recursive:true});\nwriteFileSync("eval/score.json", JSON.stringify({score:raw,valid:true,fail_class:"ok",error:null}));\n`);
  const { buildCandidatePatch, verifyCandidatePatch } = await jump("engine/campaign-patch.ts");
  const patch = buildCandidatePatch({ cycleSeedRoot: seed, targetRoot: target, candidateRoot: candidate });
  const task = { workspace: ".", score_program: `node "${scorer}"`, score_path: "eval/score.json", score_field: "score", valid_field: "valid", fail_class_field: "fail_class", error_field: "error", higher_is_better: true, evaluator_timeout_ms: 5000, copy_exclude: [] };
  const result = await verifyCandidatePatch({ dreamRoot: path.join(root, "dream"), projectDir: target, task, patch, evidenceDir: path.join(root, "evidence"), repeats: 3, minimumGain: 1, requireValidBeforeAfter: true });
  assert.deepEqual(result.pairs.map((pair) => pair.gain), [4, 0, 4]);
  assert.equal(result.medianPairedGain, 4);
  assert.equal(result.improved, true);
});

test("noisy verification rejects an invalid before score even when strict mode is omitted", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-invalid-pair-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seed = path.join(root, "seed");
  const target = path.join(root, "target");
  const candidate = path.join(root, "candidate");
  for (const dir of [seed, target, candidate]) fs.mkdirSync(dir, { recursive: true });
  for (const dir of [seed, target, candidate]) fs.writeFileSync(path.join(dir, "value.txt"), "0\n");
  fs.writeFileSync(path.join(candidate, "value.txt"), "1\n");
  const scorer = path.join(root, "score.mjs");
  fs.writeFileSync(scorer, `import { readFileSync, mkdirSync, writeFileSync } from "node:fs";\nconst after = Number(readFileSync("value.txt", "utf8")) === 1;\nmkdirSync("eval", {recursive:true});\nwriteFileSync("eval/score.json", JSON.stringify({score:after?1:0,valid:after,fail_class:"ok",error:null}));\n`);
  const { buildCandidatePatch, verifyCandidatePatch } = await jump("engine/campaign-patch.ts");
  const patch = buildCandidatePatch({ cycleSeedRoot: seed, targetRoot: target, candidateRoot: candidate });
  const task = { workspace: ".", score_program: `node "${scorer}"`, score_path: "eval/score.json", score_field: "score", valid_field: "valid", fail_class_field: "fail_class", error_field: "error", higher_is_better: true, evaluator_timeout_ms: 5000, copy_exclude: [] };
  const result = await verifyCandidatePatch({ dreamRoot: path.join(root, "dream"), projectDir: target, task, patch, evidenceDir: path.join(root, "evidence"), repeats: 3, minimumGain: 0 });
  assert.equal(result.pairs.length, 1, "invalid screen pair stops before confirmation starts");
  assert.equal(result.pairs[0].gain, null);
  assert.equal(result.improved, false);
});

test("an invalid after score in a confirming pair vetoes promotion", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-invalid-confirmation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seed = path.join(root, "seed");
  const target = path.join(root, "target");
  const candidate = path.join(root, "candidate");
  for (const dir of [seed, target, candidate]) fs.mkdirSync(dir, { recursive: true });
  for (const dir of [seed, target, candidate]) fs.writeFileSync(path.join(dir, "value.txt"), "0\n");
  fs.writeFileSync(path.join(candidate, "value.txt"), "1\n");
  const scorer = path.join(root, "score.mjs");
  const counter = path.join(root, "counter.txt");
  fs.writeFileSync(scorer, `import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";\nconst index = existsSync(${JSON.stringify(counter)}) ? Number(readFileSync(${JSON.stringify(counter)}, "utf8")) : 0;\nwriteFileSync(${JSON.stringify(counter)}, String(index + 1));\nconst patched = Number(readFileSync("value.txt", "utf8")) === 1;\nconst invalid = index === 3;\nmkdirSync("eval", {recursive:true});\nwriteFileSync("eval/score.json", JSON.stringify({score:patched ? 2 : 0,valid:!invalid,fail_class:"ok",error:null}));\n`);
  const { buildCandidatePatch, verifyCandidatePatch } = await jump("engine/campaign-patch.ts");
  const patch = buildCandidatePatch({ cycleSeedRoot: seed, targetRoot: target, candidateRoot: candidate });
  const starts = [];
  const task = { workspace: ".", score_program: `node "${scorer}"`, score_path: "eval/score.json", score_field: "score", valid_field: "valid", fail_class_field: "fail_class", error_field: "error", higher_is_better: true, evaluator_timeout_ms: 5000, copy_exclude: [] };
  const result = await verifyCandidatePatch({ dreamRoot: path.join(root, "dream"), projectDir: target, task, patch, evidenceDir: path.join(root, "evidence"), repeats: 3, minimumGain: 1, requireValidBeforeAfter: true, beforeSpawn: (key) => starts.push(key) });
  assert.equal(result.pairs.length, 2);
  assert.equal(result.pairs[1].after.valid, false);
  assert.equal(result.improved, false);
  assert.equal(starts.length, 4, "invalid confirmation stops later evaluator starts");
});

test("measurement-plan adapter keeps verified score outcomes and accepts an exact gain", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-measure-adapter-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seed = path.join(root, "seed");
  const target = path.join(root, "target");
  const candidate = path.join(root, "candidate");
  for (const dir of [seed, target, candidate]) fs.mkdirSync(dir, { recursive: true });
  for (const dir of [seed, target, candidate]) fs.writeFileSync(path.join(dir, "value.txt"), "0\n");
  fs.writeFileSync(path.join(candidate, "value.txt"), "1\n");
  const scorer = path.join(root, "score.mjs");
  const counter = path.join(root, "counter.txt");
  fs.writeFileSync(scorer, `import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";\nconst n = existsSync(${JSON.stringify(counter)}) ? Number(readFileSync(${JSON.stringify(counter)}, "utf8")) : 0;\nwriteFileSync(${JSON.stringify(counter)}, String(n + 1));\nconst value = 10 + Number(readFileSync("value.txt", "utf8"));\nmkdirSync("eval", {recursive:true});\nwriteFileSync("eval/score.json", JSON.stringify({score:value,raw_score:value,valid:true,fail_class:"ok",error:null}));\n`);
  const { buildCandidatePatch, verifyCandidatePatch } = await jump("engine/campaign-patch.ts");
  const { planTest } = await jump("engine/measure.ts");
  const patch = buildCandidatePatch({ cycleSeedRoot: seed, targetRoot: target, candidateRoot: candidate });
  const starts = [];
  const task = { workspace: ".", score_program: `node "${scorer}"`, score_path: "eval/score.json", score_field: "score", valid_field: "valid", fail_class_field: "fail_class", error_field: "error", higher_is_better: true, evaluator_timeout_ms: 5000, copy_exclude: [] };
  const result = await verifyCandidatePatch({
    dreamRoot: path.join(root, "dream"), projectDir: target, task, patch, evidenceDir: path.join(root, "evidence"),
    measurementPlan: planTest({ baseline: [10, 10, 10], higherIsBetter: true, threshold: 0.5, maxCycles: 5, deterministic: true }),
    beforeSpawn: (key) => starts.push(key),
  });
  assert.equal(starts.length, 2);
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0].gain, 1);
  assert.equal(result.medianAfter, 11);
  assert.equal(result.improved, true);
});
