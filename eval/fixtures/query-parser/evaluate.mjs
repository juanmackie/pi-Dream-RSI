import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const { parseQuery } = await import(pathToFileURL(`${process.cwd()}/query.mjs`));
const cases = [
  ["name=ada", { name: ["ada"] }],
  ["q=hello+world", { q: ["hello world"] }],
  ["a%20b=value%2Fone", { "a b": ["value/one"] }],
  ["tag=alpha&tag=beta", { tag: ["alpha", "beta"] }],
  ["token=a%3Db", { token: ["a=b"] }],
  ["empty=", { empty: [""] }],
];
let accepted = 0;
for (const [input, expected] of cases) {
  try {
    const actual = parseQuery(input);
    if (actual instanceof Map && JSON.stringify(Object.fromEntries(actual)) === JSON.stringify(expected)) accepted += 1;
  } catch { /* a rejected case contributes no accepted points */ }
}
const sourceBytes = readFileSync("query.mjs").byteLength;
mkdirSync("eval", { recursive: true });
writeFileSync("eval/score.json", JSON.stringify({ score: accepted, valid: true, fail_class: "ok", error: null, accepted, cases: cases.length, output_bytes: sourceBytes }));
