import { pathToFileURL } from "node:url";

const { parseQuery } = await import(pathToFileURL(`${process.cwd()}/query.mjs`));
const cases = [
  ["", {}],
  ["x=1&x=2&y=", { x: ["1", "2"], y: [""] }],
  ["__proto__=safe&constructor=plain", JSON.parse('{"__proto__":["safe"],"constructor":["plain"]}')],
  ["alpha=first&&beta=second", { alpha: ["first"], beta: ["second"] }],
  ["item0=value0&item1=value1&item2=value2&item3=value3", {
    item0: ["value0"], item1: ["value1"], item2: ["value2"], item3: ["value3"],
  }],
];
for (const [input, expected] of cases) {
  const actual = parseQuery(input);
  if (!(actual instanceof Map) || JSON.stringify(Object.fromEntries(actual)) !== JSON.stringify(expected)) process.exit(1);
}
