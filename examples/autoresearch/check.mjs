import { readFileSync } from "node:fs";

const value = Number(readFileSync(new URL("./src/value.txt", import.meta.url), "utf8"));
if (!Number.isSafeInteger(value) || value < 8) {
  console.error("value must be an integer of at least 8");
  process.exitCode = 1;
}
