import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runControllerBenchmark } from "./controller.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function scoreController(workspace) {
  const config = JSON.parse(fs.readFileSync(path.join(root, ".auto/controller-config.json"), "utf8"));
  const baseline = fs.readFileSync(path.join(root, config.candidate_path));
  if (crypto.createHash("sha256").update(baseline).digest("hex") !== config.baseline_sha256) throw new Error("protected controller baseline changed");
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-controller-score-"));
  try {
    const result = await runControllerBenchmark({ campaignModule: path.join(workspace, config.candidate_path), workRoot });
    return { score: result.score, valid: result.passed, fail_class: result.passed ? "ok" : "controller_regression",
      error: result.passed ? null : "candidate controller failed a protected behavior scenario", benchmark: result };
  } finally { fs.rmSync(workRoot, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try { result = await scoreController(path.resolve(process.argv[2] ?? ".")); }
  catch (error) { result = { score: 0, valid: false, fail_class: "scorer_error", error: error.message }; }
  fs.mkdirSync("eval", { recursive: true });
  fs.writeFileSync("eval/score.json", `${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.valid ? 0 : 1;
}
