import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const reportPath = process.env.DREAM_RSI_CLI_E2E_REPORT;
const recorderPath = process.env.DREAM_RSI_CLI_E2E_RECORDER;
const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piRoot = path.dirname(path.dirname(piEntry));
const { createJiti } = await import(pathToFileURL(path.join(piRoot, "node_modules", "jiti", "lib", "jiti.mjs")).href);
const indexPath = path.join(process.env.DREAM_RSI_REPO, "extensions", "pi-dream-rsi", "index.ts");
const loaded = await createJiti(import.meta.url).import(indexPath);
const dreamRsi = loaded.default;

export default function campaignCliE2e(pi) {
  const tools = new Map();
  const commands = new Map();
  const skillRoutes = [];
  const api = new Proxy(pi, {
    get(target, key) {
      if (key === "registerTool") return (definition) => { tools.set(definition.name, definition); target.registerTool(definition); };
      if (key === "registerCommand") return (name, definition) => { commands.set(name, definition); target.registerCommand(name, definition); };
      if (key === "sendUserMessage") return (content, options) => { skillRoutes.push({ content, options }); };
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  dreamRsi(api);

  pi.registerCommand("fixture-e2e", {
    description: "Run the deterministic Dream-RSI CLI integration fixture.",
    handler: async (_args, ctx) => {
      try {
        const improve = tools.get("dream_rsi_improve");
        const signals = tools.get("dream_rsi_signals");
        const command = commands.get("dream-rsi");
        assert.ok(improve && signals && command, "the real extension registered its command and tools through Pi");

        const guarded = await improve.execute("guard-before-mode", { action: "check" }, undefined, undefined, ctx);
        // An interactive/RPC host is asked first; a declining client gets the canceled
        // path, which must not run the evaluator or create campaign state.
        assert.match(guarded.content[0].text, /no confirmation was given/);
        assert.equal(guarded.details.cancelled, true);
        assert.equal(fs.existsSync(path.join(ctx.cwd, ".dream-rsi", "campaigns")), false);

        await command.handler("assess make the parser faster", ctx);
        await command.handler("improve make the parser faster", ctx);
        assert.ok(skillRoutes.some((route) => route.content === "/skill:dream-rsi-assess make the parser faster"));
        assert.ok(skillRoutes.some((route) => route.content === "/skill:dream-rsi-improve make the parser faster"));

        const session = typeof ctx.sessionManager.appendMessage === "function"
          ? ctx.sessionManager
          : SessionManager.create(ctx.cwd, ctx.sessionManager.getSessionDir());
        const now = Date.now();
        session.appendMessage({
          role: "assistant",
          content: [{ type: "toolCall", id: "fixture-failure", name: "bash", arguments: { command: "npm test" } }],
          timestamp: now,
          provider: "fixture",
          model: "fixture",
          api: "fixture",
          usage: {},
          stopReason: "toolUse",
        });
        session.appendMessage({
          role: "toolResult",
          toolCallId: "fixture-failure",
          toolName: "bash",
          content: [{ type: "text", text: "AssertionError: parser fixture failed" }],
          isError: true,
          timestamp: now + 1200,
          details: { durationMs: 1200 },
        });
        const signalTimestamp = new Date(Date.now() - 5000);
        fs.utimesSync(session.getSessionFile(), signalTimestamp, signalTimestamp);
        const signalResult = await signals.execute("signals", { focus: "parser", include_logs: true }, undefined, undefined, ctx);
        assert.match(signalResult.content[0].text, /npm test/);

        const projectDir = ctx.cwd;
        const seed = path.join(projectDir, "seed");
        fs.mkdirSync(seed, { recursive: true });
        fs.writeFileSync(path.join(seed, "solution.py"), "x\n");
        fs.writeFileSync(path.join(projectDir, "PROBLEM.md"), "Improve parser throughput while preserving output.\n");
        const scorer = path.join(projectDir, "score.mjs");
        const gate = path.join(projectDir, "gate.mjs");
        const agent = path.join(projectDir, "agent.mjs");
        fs.writeFileSync(scorer, `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const recorder = ${JSON.stringify(recorderPath)};
const counter = ${JSON.stringify(path.join(path.dirname(recorderPath), "score-count.txt"))};
const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;
writeFileSync(counter, String(n));
appendFileSync(recorder, JSON.stringify({ role: "scorer", argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
const source = readFileSync("solution.py", "utf8");
const jitter = [0, 2, 1][(n - 1) % 3];
const score = (source.match(/x/g) ?? []).length * 100 + jitter;
import { mkdirSync } from "node:fs";
mkdirSync("eval", { recursive: true });
writeFileSync("eval/score.json", JSON.stringify({ score, valid: true, fail_class: "ok", error: null }));
`);
        fs.writeFileSync(gate, `
import { appendFileSync, readFileSync } from "node:fs";
const recorder = ${JSON.stringify(recorderPath)};
appendFileSync(recorder, JSON.stringify({ role: "gate", argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
if (!readFileSync("solution.py", "utf8").includes("x")) process.exit(1);
`);
        fs.writeFileSync(agent, `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const recorder = ${JSON.stringify(recorderPath)};
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const role = /Do not change files/i.test(prompt) ? "probe"
    : /adversarial review/i.test(prompt) ? "review"
      : /prefix-only exploration policy/i.test(prompt) ? "dream" : "live";
  appendFileSync(recorder, JSON.stringify({ role, argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
  if (role === "review") { writeFileSync("review.json", JSON.stringify({ verdict: "accept", reasons: [] })); return; }
  if (role === "probe" || role === "dream") { process.stdout.write("Fixture inspected the requested files.\\n"); return; }
  const source = readFileSync("solution.py", "utf8");
  writeFileSync("solution.py", source + "xxx\\n");
  writeFileSync("proposal.md", "# Add a measured parser optimization\\n");
});
`);

        const task = {
          name: "CLI parser improvement fixture",
          workspace: "seed",
          eval_program: "solution.py",
          score_program: `node "${scorer}"`,
          problem_file: "PROBLEM.md",
          higher_is_better: true,
          agent_command: process.execPath,
          agent_args: [agent, recorderPath],
          agent_timeout_ms: 30_000,
          evaluator_timeout_ms: 30_000,
        };
        const verifierInputs = [scorer, gate];
        const gates = [`node "${gate}"`];

        const relative = await improve.execute("relative-check", {
          action: "check", project_dir: projectDir,
          task: { ...task, score_program: "node ../score.mjs" },
          verifier_inputs: verifierInputs,
        }, undefined, undefined, ctx);
        assert.match(relative.content[0].text, /use an absolute path/);

        const checked = await improve.execute("preflight-check", {
          action: "check", project_dir: projectDir, task,
          verifier_inputs: verifierInputs, gates,
        }, undefined, undefined, ctx);
        assert.equal(checked.details.check.runs[0].valid, true, checked.content[0].text);
        assert.equal(checked.details.check.gateRuns[0].passed, true, checked.content[0].text);

        const beforeStart = fs.existsSync(recorderPath) ? fs.readFileSync(recorderPath, "utf8").trim().split(/\r?\n/).filter(Boolean).length : 0;
        const started = await improve.execute("campaign-start", {
          action: "start", project_dir: projectDir,
          goal: "Improve parser throughput while preserving output",
          task, scope: ["solution.py"], verifier_inputs: verifierInputs,
          gates, max_cycles: 1, max_agent_starts: 24, max_evaluator_runs: 80,
        }, undefined, undefined, ctx);
        const campaign = started.details.campaign;
        assert.equal(campaign.state.kind, "complete", started.content[0].text);
        assert.deepEqual(campaign.completedCycles, [1]);
        const campaignRecord = JSON.parse(fs.readFileSync(path.join(campaign.campaignRoot, "campaign.json"), "utf8"));
        assert.equal(campaignRecord.baselineScores.length, 5);
        assert.ok(campaign.currentScore > Math.max(...campaignRecord.baselineScores) + campaignRecord.minimumGain,
          "the final score exceeds the requested minimum gain over the five-score baseline");
        const after = fs.readFileSync(recorderPath, "utf8").trim().split(/\r?\n/).filter(Boolean).slice(beforeStart).map((line) => JSON.parse(line));
        const recordedAgentStarts = after.filter((row) => ["probe", "live", "dream", "review"].includes(row.role)).length;
        const recordedEvaluatorStarts = after.filter((row) => ["scorer", "gate"].includes(row.role)).length;
        assert.equal(campaign.agentStarts, recordedAgentStarts, "agent ledger equals captured probe/live/dream/review subprocesses");
        assert.equal(campaign.evaluatorRuns, recordedEvaluatorStarts, "evaluator ledger equals captured scorer/gate subprocesses");
        assert.ok(after.some((row) => row.role === "probe"));
        assert.ok(after.some((row) => row.role === "live"));
        assert.equal(after.some((row) => row.role === "dream"), false,
          "one-cycle campaigns skip policy dreaming until two eligible worlds exist");
        assert.ok(after.some((row) => row.role === "review"));
        assert.ok(after.some((row) => row.role === "gate"));
        assert.ok(after.filter((row) => row.role === "scorer").length >= 10, "five baseline and five final verification measurements ran");
        const baselineRows = after.filter((row) => row.role === "scorer").slice(0, 5);
        const firstAgentIndex = after.findIndex((row) => ["probe", "live", "dream", "review"].includes(row.role));
        assert.equal(after.indexOf(baselineRows.at(-1)) < firstAgentIndex, true,
          "all baseline measurements finish before the probe starts");
        const appliedFile = path.join(seed, "solution.py");
        const appliedBytes = fs.readFileSync(appliedFile);
        const appliedSource = appliedBytes.toString("utf8");
        assert.match(appliedSource, /^x\n(?:xxx\n)+$/, "the applied result contains only whole fixture candidate additions");
        const appliedRecords = fs.readFileSync(path.join(campaign.campaignRoot, "history", "applied.jsonl"), "utf8")
          .trim().split(/\r?\n/).map((line) => JSON.parse(line));
        assert.equal(appliedRecords.length, 1);
        const ledgerText = fs.readFileSync(path.join(campaign.campaignRoot, "history", "ledger.jsonl"), "utf8");
        const dreamSkip = ledgerText.trim().split(/\r?\n/).map((line) => JSON.parse(line))
          .find((entry) => entry.kind === "dream" && entry.outcome === "skipped");
        assert.ok(dreamSkip && dreamSkip.facts.eligibleWorlds < 2,
          "the ledger explains that fewer than two eligible worlds were available for dreaming");
        const applied = appliedRecords[0];
        const evidenceDir = path.join(campaign.campaignRoot, "history", "r0001_campaign", applied.cell);
        const reviewDir = path.join(evidenceDir, "review");
        const review = JSON.parse(fs.readFileSync(path.join(reviewDir, "review.json"), "utf8"));
        assert.equal(review.verdict, "accept");
        const reviewText = fs.readFileSync(path.join(reviewDir, "REVIEW.md"), "utf8");
        const pairsLine = /^Paired measurements: (.+)$/m.exec(reviewText)?.[1];
        assert.ok(pairsLine, "the accepted review includes saved paired measurement evidence");
        const pairs = JSON.parse(pairsLine);
        const confirmationPairs = fs.readFileSync(path.join(campaign.campaignRoot, "history", "ledger.jsonl"), "utf8")
          .trim().split(/\r?\n/).map((line) => JSON.parse(line))
          .filter((entry) => entry.kind === "confirm" && entry.facts?.iteration === applied.iteration && entry.facts?.cell === applied.cell);
        assert.equal(pairs.length, confirmationPairs.length, "the review evidence contains every recorded confirmation pair");
        assert.ok(pairs.length >= 1, "the sequential test records at least one confirmation pair");
        assert.ok(pairs.every((pair) => pair.before.valid && pair.after.valid && pair.gain > campaignRecord.minimumGain));
        const reviewedAfter = fs.readFileSync(path.join(reviewDir, "after", "solution.py"));
        assert.deepEqual(appliedBytes, reviewedAfter, "the bytes reviewed by the accepting agent are the bytes applied");
        const journal = JSON.parse(fs.readFileSync(path.join(campaign.campaignRoot, "promotion-journal", `${applied.campaign_transaction}.json`), "utf8"));
        const journalEntry = journal.entries.find((entry) => entry.relative === "solution.py");
        assert.equal(journal.state, "applied");
        assert.equal(journalEntry.afterHash, crypto.createHash("sha256").update(appliedBytes).digest("hex"));

        const expectedModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
        const expectedThinking = ctx.thinkingLevel ?? null;
        const agentRows = after.filter((row) => ["probe", "live", "dream", "review"].includes(row.role));
        if (expectedModel) assert.ok(agentRows.every((row) => row.argv.includes("--model") && row.argv.includes(expectedModel)));
        if (expectedThinking && expectedModel) assert.ok(agentRows.every((row) => row.argv.includes("--thinking") && row.argv.includes(expectedThinking)));

        const payload = {
          ok: true,
          routedSkills: skillRoutes.map((route) => route.content),
          signal: signalResult.content[0].text,
          relativeCheck: relative.content[0].text,
          baselineScores: campaignRecord.baselineScores,
          agentStartsAtBaseline: 0,
          cycle: campaign.completedCycles[0],
          counters: { agentStarts: campaign.agentStarts, recordedAgentStarts, evaluatorRuns: campaign.evaluatorRuns, recordedEvaluatorStarts },
          roles: after.map((row) => row.role),
          finalState: campaign.state,
          applied: fs.existsSync(path.join(campaign.campaignRoot, "history", "applied.jsonl")),
          pairedMeasurements: pairs,
          confirmationCount: confirmationPairs.length,
          reviewVerdict: review.verdict,
          appliedHash: journalEntry.afterHash,
          resolvedModel: expectedModel,
          resolvedThinking: expectedThinking,
        };
        fs.writeFileSync(reportPath, JSON.stringify(payload, null, 2));
        ctx.ui.notify("CLI campaign fixture completed", "info");
      } catch (error) {
        fs.writeFileSync(reportPath, JSON.stringify({ ok: false, error: error instanceof Error ? error.stack : String(error) }, null, 2));
        ctx.ui.notify("CLI campaign fixture failed", "error");
      }
    },
  });
}
