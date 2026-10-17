# Run and evaluate self-improvement

Use a development checkout with Node.js 22.18 or newer and its dependencies installed. Campaigns apply
accepted patches to the working tree and retain a recovery journal. They do not commit or publish.

## Measure the tool

```sh
npm run typecheck
npm test
node eval/bench.mjs --seeds 20000
node eval/bench.mjs --held-out --seeds 5000
node eval/bench.mjs --pairs 32 --seeds 5000
```

DreamBench calls the actual measurement module with seeded scalar instruments. It records acceptance,
actual evaluator callbacks, measurement order, and one-sided exact Clopper–Pearson confidence bounds.
The comparison models the previous median-of-three procedure, including its first-pair screen.

Five identical baseline samples are evidence for a deterministic instrument, not proof. Discrete noisy
instruments can still coincide five times. The confidence bounds describe simulated distributions.
They do not certify arbitrary heavy tails, correlations, or changes in the environment.

The pure module defaults to eight pairs for repeatable benchmark comparisons. Campaigns choose up to
32 noisy pairs from the remaining evaluator and time budgets. A five-percent minimum and ten-percent
true gain leave only five percentage points of evidence to detect. Small budgets can have little
power in that situation. Inspect the reported minimum detectable effect and evaluator cost.

## Prepare a measurement campaign

```sh
node scripts/setup-self-campaign.mjs --target=measure
```

The command prints a content-addressed verifier directory and an intake path. The candidate scope is
`engine/measure.ts`. The verifier imports that candidate, exercises the real paired runner, and compares
it with a byte-verified baseline. Its objective is:

```text
J = mean positive-scenario power - 0.25 * (mean evaluator runs / 16)
score = J - 0.01 * (added code tokens / 50)
```

Removed tokens earn the same credit. Token counts omit comments and whitespace. Held-out J and primary
and held-out power must remain within 0.005 of baseline. Null and boundary false-accept confidence bounds
must pass the fixed alpha. The AST gate rejects imports, I/O, clocks, randomness, dynamic evaluation,
reflection, and unsafe computed property access. It is a restricted-code check, not an OS sandbox.
The full test suite is a separate correctness gate, copied from the immutable snapshot before execution.

Run `node scripts/smoke-self-improve.mjs` for a provider-free campaign that removes a planted redundant
branch in a temporary checkout, verifies it against the protected scorer, and applies the accepted patch.
Its smaller simulation sets and focused correctness gate make it an integration check; run the commands
above for the full suite and statistical reports.

Inspect the intake, then use its path:

```text
/dream-rsi start /absolute/path/to/.dream-rsi/self-campaign-HASH.json
```

The command and `dream_rsi_improve` use the same intake parser. Missing direction, unknown fields, and
obsolete internal knobs fail at that boundary. Start runs preflight before any agent.

## Mine structural weaknesses

```sh
node scripts/self-improve.mjs
node scripts/self-improve.mjs --no-session-logs
```

The miner reads at most 12 recent project session directories and 30 recent JSONL files per directory
from `PI_CODING_AGENT_DIR/sessions` or `~/.pi/agent/sessions`. `PI_SESSION_DIR` supplies a flat override.
It also reads recent campaign records, identifies project roots from session headers, and emits counts with hashed project identifiers. It writes observations and a generated
`eval/scenarios.json` beneath `.dream-rsi/self-improvement/`, then snapshots those scenarios into the
verifier. It does not overwrite the repository's versioned scenario set. Repeated preparation replaces
the same bounded observation files instead of growing an unbounded event log.

Mined stress parameters are deterministic heuristics from structural counts. They are not measurements
of a project's noise. Transcript prose, raw tool arguments, and private project paths are excluded.

## Evaluate controller changes

```sh
node scripts/setup-self-campaign.mjs --target=controller
node --test tests/campaign-scenarios.test.mjs
```

The protected controller evaluator imports the candidate campaign module and creates isolated fixture
projects with scripted agents. It independently checks final files, scorer and gate results, verifier
hashes, and observed process starts. A false apply invalidates the result. The objective is verified
wins per agent start. This tier measures controller behavior; it does not establish prompt quality.

The previous exploration-policy target remains available with `--target=policy`.

## Budget real-model prompt evaluation

```sh
node eval/tier2.mjs --list
node eval/tier2.mjs
```

The default command makes no model calls. Fixtures cover Node operation counts, Python parsing latency,
and query-parser acceptance with size diagnostics and held-out correctness checks. Each has a planted
lever and a control patch. Baseline gates protect existing behavior; the metric captures the behavior to improve. Local tests qualify their baseline and control behavior.

An explicit run requires a model, per-fixture budgets, and an empty output directory:

```sh
node eval/tier2.mjs --run --model=PROVIDER/MODEL --agent-budget=12 --evaluator-budget=80 --global-agent-budget=36 --budget-file=/absolute/cumulative-budget.json --output=/absolute/new/report-directory
```

The agent limit applies per fixture, and the optional global counter caps starts across fixtures and
reruns. Keep the same budget file and limit when retrying. Each evaluator budget includes two independent
ground-truth measurements after the campaign. Use `--fixtures=node-index,python-csv` for a focused run.
The default campaign needs at least eight agent starts to reach its first reviewed promotion.

Use the resulting baseline summary to prepare a prompt self-target:

```sh
node scripts/setup-self-campaign.mjs --target=prompts --tier2-model=PROVIDER/MODEL --tier2-budget=36 --tier2-baseline=/absolute/report-directory/tier2-summary.json
```

The baseline must describe the current prompts and the same model. Prompt evaluation uses that model
for every role. Its durable total agent budget is cumulative across evaluator calls and retries. A
corrupt, exhausted, or changed budget fails closed. False applies and regressions in proposal, edit,
timeout, or verified-win rates prevent promotion. No prompt self-target is certified by scripted agents.
Planted-lever metadata is a fixture reference. Run `node eval/assess.mjs --list` to inspect the separate
assessment evaluation. It is inert by default. Its `--run` path takes the same explicit model, selected
fixtures, durable global budget, and output options as Tier2. It exposes source-only copies through
read-only tools and reports structure, scope, direction, evaluator kind, readiness, and lexical metric
matching. Semantic goal correctness is not automatically judged. Assessment and improvement runs can
share the same budget file, so their combined starts never exceed its limit.

An OS scheduler can invoke `pi -p "/dream-rsi start /absolute/path/to/intake.json"`. Scheduling and
commit, push, merge, and publication are separate actions. This package installs no scheduler.
