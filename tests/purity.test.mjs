import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { purityViolations, countCodeTokens } from "../eval/purity.mjs";

test("token accounting excludes trivia and counts code after template literal types", () => {
  const source = 'export type Unit = `${number}%`; export function f(x: number) { return x; }';
  assert.equal(countCodeTokens(source), countCodeTokens(`/** Header. */\n${source}\n// tail\n`));
  assert.equal(countCodeTokens("export const x = 1;"), 6);
  assert.ok(countCodeTokens(`${source} export const additional = 1;`) > countCodeTokens(source));
  assert.ok(countCodeTokens(source.replace("return x;", "if (x > 0) return x; return 0;")) > countCodeTokens(source));
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("purity gate accepts the production measurement module and numeric array indexing", () => {
  const source = fs.readFileSync(path.join(root, "extensions/pi-dream-rsi/engine/measure.ts"), "utf8");
  assert.deepEqual(purityViolations(source, "measure.ts"), []);
  assert.deepEqual(purityViolations("const values = [2, 3]; export const result = values[index - 1];"), []);
});

test("purity gate rejects constructor access through computed keys and aliases", () => {
  const cases = [
    'const F = ({} )["constructor"]["constructor"];',
    'const key = "con" + "structor"; const F = ({})[key];',
    'const { ["constructor"]: F } = {};',
    'const key = "constructor"; const F = ({})[key];',
  ];
  for (const source of cases) assert.ok(purityViolations(source).length > 0, source);
});

test("purity gate rejects hidden clocks, randomness, runtime globals and reflection", () => {
  const cases = [
    'const random = Math["random"];',
    "const random = Math.random;",
    "const now = Date.now();",
    "const value = crypto.getRandomValues(new Uint8Array(4));",
    "const prototype = Object.getPrototypeOf({});",
    "const value = Reflect.get({}, 'x');",
    "const value = globalThis.process;",
    "const value = import('./payload.js');",
  ];
  for (const source of cases) assert.ok(purityViolations(source).length > 0, source);
});
