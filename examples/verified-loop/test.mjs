import assert from "node:assert/strict";
import { buildReport } from "./src/pipeline.mjs";

const items = Array.from({ length: 64 }, (_, index) => `item-${index};`);
const checksum = items.reduce((total, item, index) => total + item.length * (64 - index), 0);
const expected = items.join("") + "#" + checksum;
assert.equal(buildReport(64), expected, "the optimized implementation must preserve exact output");
