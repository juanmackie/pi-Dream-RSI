import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { createLookup } = await import(pathToFileURL(`${process.cwd()}/lookup.mjs`));
const entries = Array.from({ length: 256 }, (_, index) => [`key-${index}`, index]);
const lookup = createLookup(entries);
let comparisons = 0;
let valid = true;
for (let repeat = 0; repeat < 12; repeat += 1) {
  for (let index = 0; index < entries.length; index += 1) {
    const result = lookup(`key-${index}`);
    comparisons += result.comparisons;
    if (result.value !== index) valid = false;
  }
  if (lookup("absent").value !== null) valid = false;
}
mkdirSync("eval", { recursive: true });
writeFileSync("eval/score.json", JSON.stringify({ score: comparisons, valid, fail_class: valid ? "ok" : "wrong_answer", error: valid ? null : "lookup mismatch" }));
