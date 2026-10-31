import { readFileSync } from "node:fs";

const value = Number(readFileSync(new URL("./src/value.txt", import.meta.url), "utf8"));
if (!Number.isFinite(value)) process.exitCode = 1;
else console.log(value);
