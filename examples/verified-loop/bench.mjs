import { buildReport } from "./src/pipeline.mjs";

let report = "";
for (let repeat = 0; repeat < 4; repeat += 1) report = buildReport(22_000);
if (report.length === 0) {
  console.error("pipeline produced no output");
  process.exit(1);
}
console.log(report.length);
