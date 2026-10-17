import { pathToFileURL } from "node:url";
const { createLookup } = await import(pathToFileURL(`${process.cwd()}/lookup.mjs`));
const cases = [
  { entries: [["a", 1], ["a", 2]], key: "a", expected: 1 },
  { entries: [["a", 1]], key: "missing", expected: null },
  { entries: [], key: "empty", expected: null },
  { entries: [["__proto__", 7], ["constructor", 8]], key: "__proto__", expected: 7 },
];
for (const item of cases) if (createLookup(item.entries)(item.key).value !== item.expected) process.exit(1);
