# Dream-RSI loop design record

General, unattended RSI loop on top of the existing campaign engine. Point the tool at any
repository; it ranks levers, creates and calibrates a metric, runs improvement campaigns until a
verified gain lands, applies it, records the outcome, and continues to the next lever within
fail-closed budgets. The user's pass rule applies everywhere: a step counts as passed only when
demonstrated through variation (repeats, varied fixtures, controls), not by one successful run.

## Current state (verified on the working tree)

- `runCampaign` in `engine/campaign.ts` is already self-contained per goal: trusted-verifier rules,
  evaluator preflight with baseline reads and gates, live/dream/promote cycles, paired confirmation,
  adversarial review, scoped apply with a recovery journal, plateau stop, resume, and a durable
  process budget (`campaign-budget.ts`, `CampaignLimitError`).
- Preflight already validates a supplied `controlPatch` (`checkCampaignEvaluator`): a known-better
  patch must confirm above the threshold before the metric is trusted (`control.validated`).
- Cross-campaign memory exists: `campaignMemory()` gathers ledger entries from all prior campaigns of
  the same project and fingerprint, and `ledgerDigest()` feeds them to each live cycle.
- The extension exposes `dream_rsi_improve` (structured lever objects from assess feed `start`) and
  `dream_rsi_signals` (bounded aggregates). What is missing: choosing the next lever itself, an
  evaluator that goes with a lever when none is supplied, and chaining beyond one campaign.

## Mechanisms taken from the primary sources

- RSI-Master (arXiv 2609.35561v2, §2.2–2.3): organize experimental actions through an event schema and
  an append-only experiment graph with integrity status; grow a research DAG where Workers explore
  directions, Reviewers compare evidence across workers, and the main agent redirects. Hacking is
  bounded by regularizing actions (§3.5: 0.0% hacking rate); lock-in is bounded by review-driven
  redirection late in the budget (§3.6).
- MASS (pub.sakana.ai/mass, arXiv 2610.12176): the optimizer, not the evaluator, is often the RSI
  bottleneck (Fig. 7); noisy text-space search needs stability control (Fig. 8). For us: spend budget
  on direction allocation and restarts, not only on tighter scoring.
- Memento (Anthropic self-replicating-AI post, Appendix A): fresh agent instances inherit a short
  notes file of strategies tried and failures; this counters fixation in long runs.
- Local paper (2609.14858; docs/method.md): replay objective v1
  `V = best_score − beta1·N + beta2·N/max(1,k*)` over four synthetic worlds; the runtime only
  establishes contract compliance and regression, never real-project generalization — which is why
  every loop claim needs its own external evidence (fixtures, controls).

## Loop architecture

New module `engine/loop.ts` plus a persisted loop state under `.dream-rsi/loop/`. One loop step maps
to one campaign; the loop never reuses campaign internals. Reused contracts: `runCampaign`,
`resumeCampaign`, `checkCampaignEvaluator`, `CampaignBudget` pattern, ledger, prompts.

Per iteration, in order, each step fail-closed:

1. Inventory — build lever candidates from `collectSignals` output, prior ledgers, and a bounded
   discovery agent (`prompts/discovery-agent.md` role). Each lever carries: mechanism, evidence,
   file scope, proposed metric kind, gates, expected gain, cost estimate, confidence. No repository
   names or benchmark answers ever enter production decisions.
2. Selection — UCB1-style allocation across levers using recorded win rate and evaluator cost from
   the loop ledger; a lever that recently failed or was tried with an identical patch hash is
   demoted. This is the anti-lock-in stage (archive + allocation rather than single-chain refinement).
3. Metric — if the intake has no evaluator, synthesize one that satisfies the verifier contract:
     - score wrapper through `evaluators/measure.mjs` (`stdout-number` / `elapsed` modes) pinned in
       the protected verifier subtree, or a wrapper around the project's own benchmark command;
     - gates default to the project's existing test command when declared in `verifier_inputs`;
     - a known-better control patch authored mechanically for the lever (never by the candidate
       agent), validated through `checkCampaignEvaluator` control validation before any campaign;
     - levers whose metric cannot pass preflight (spread, MDE, budget fit) are returned to the
       inventory with a reason, not retried blind.
4. Campaign — run `runCampaign` with the lever as goal, calibrated minimum gain, control patch, and
   loop-bounded limits. On plateau, write a Memento-style notes file (strategies tried, failures) and
   read it in the next attempt's discovery context.
5. Outcome — append loop records to the existing campaign ledger stream; update lever statistics;
   continue while budget, deadline, inventory, and stop rules allow. Stop rules: loop budget
   exhausted, inventory empty, K consecutive plateaued levers without a verified gain. Fail closed:
   any integrity error stops the loop, not the next lever.

Boundaries kept from the repo: no commit/push/merge/publish/scheduler install; applied patches stay
uncommitted with journals; secrets and production systems stay out of candidate workspaces.

## Validation strategy (pass = variation)

- Fixture repos with planted levers (Node and Python, per the tier2 pattern in `eval/fixtures/`),
  plus a no-op control repo and held-out variants. Unattended runs from fresh clones to applied,
  verified patches.
- Known-positive control (planted lever found), known-negative control (no-op target: zero applied
  changes), scenario runs (cheat, duplicate, noise, timeout) with false applies required to stay 0.
- Repeats with varied seeds/fixtures; report cost per verified win (evaluator runs, agent starts,
  wall-clock) with variability, and identify where the loop rather than the evaluator is the
  bottleneck.

## Non-goals

- No weight fine-tuning (MASS outer loop) — out of scope for a repo-improvement tool.
- No reuse of the legacy manual loop (`history/`, old `task.json` runs).
- No scheduler installation; unattended means one `pi -p` invocation runs the loop to a stop rule.

## Progress ledger (loop-core implementation)

Baseline (2026-10-16, tree `codex/dream-rsi-2`, uncommitted):

- `npm run typecheck`: clean.
- Full `npm test`: 255 tests, 253 pass, 2 fail. Both fail entries are one root cause:
  `tests/campaign-scenarios.test.mjs` subtest "valid edits survive an agent timeout assessment"
  (node counts the subtest and its parent suite). Standalone rerun of the whole file: 10/10 pass,
  including that subtest (11.4 s). Diagnosis: load-sensitive timing — the scenario pins
  `agent_timeout_ms: 1500` and under full-suite parallel load the stub agent is killed before its
  edits land, so all candidates score 0. Pre-existing; harden the margin before final validation
  without weakening any assertion.

Completed slices (each with behavioral tests + `npm run typecheck` clean):

- `engine/levers.ts` — evidence-ranked lever inventory on top of `collectSignals`: expected gain,
  cost, confidence, readiness estimates; stable content-addressed lever ids; canonical
  runnable-head screening (generic `node`/`git` labels rejected as unreconstructible);
  attempt-history demotion; rejections carry exact reasons; `leverIntake()` maps to the public
  intake lever shape. Tests: `tests/levers.test.mjs` (5), including cross-language equivalence
  (npm vs pytest) and a private-text redaction check.
- `engine/metrics.ts` — metric synthesis when intake has no evaluator: generates a pinned
  evaluator under `.dream-rsi/loop/metrics/<leverId>/evaluate.mjs` (failure-count and duration
  modes), resolves runner argv from standard lockfiles (npm/pnpm/yarn/bun) and canonical heads,
  keeps gates for duration levers and excludes the metric command as a gate for failure-count
  levers, and fails closed without a non-empty known-better control patch. Tests:
  `tests/metrics.test.mjs` (5) with positive/negative controls (fix present/absent, faster/slower
  variant, broken command → invalid score).
- `engine/search.ts` — loop memory and allocation: UCB1 selection over lever inventory score with
  an exploration bonus (c = 1.2), untried levers first; durable memory (`.dream-rsi/loop/memory.json`)
  with per-lever stats and latest-outcome attempts that feed inventory demotion; corruption fails
  closed; bounded Memento digest (notes first, then stats and recent outcomes) for fresh-context
  restarts; plateau = consecutive campaign outcomes without a win, skipping screening rejections.
  Tests: `tests/search.test.mjs` (4).
- `engine/loop.ts` — campaign chaining controller. One iteration = recon (`collectSignals`) → lever
  inventory → UCB pick → metric synthesis (or a fixture/intake `taskProvider` seam) → one bounded
  `runCampaign` → ledger win detection → durable outcome record → re-rank. Fail-closed loop budget
  in `.dream-rsi/loop/budget.json` (immutable limits, durable spend, conservative grants per
  campaign = min(campaign cap, remaining)); stop reasons: budget, deadline, plateau (all levers
  tried), blocked (unfinished campaign), cancelled (stop request consumed between campaigns),
  empty inventory, no verifiable lever, campaign failed. Unscoped/command-only levers and levers
  without a control patch are recorded as rejected with reasons instead of explored. The default
  task points a repo-root campaign at the synthesized evaluator via an absolute `node "<path>"`
  score program; `.dream-rsi/loop` sits inside the trusted verifier subtree that
  `assertTrustedVerifier` accepts, and campaign preflight failures return as `state: failed`
  results (classified as screening rejections). Tests: `tests/loop.test.mjs` (12) — win path with
  synthesis, empty inventory, rejection without control patch, plateau, durable budget across runs
  with immutable limits and fail-closed counter validation, engine-throw, blocked guard,
  stop-request cancellation, taskProvider seam, applied-then-failed stop, and preflight-rejection
  screening continuing past the rejected lever.
- Extension surface: `dream_rsi_loop` tool (start/status) with mode gating, durable caps
  (`max_campaigns` 6, `max_agent_starts` 72, `max_evaluator_runs` 200, `deadline_minutes` 120,
  `plateau_k` 3, per-campaign caps), optional `control_patch`, agent/timeout overrides, session
  model resolution and dashboard passthroughs; `/dream-rsi loop <intent>` command; help and
  completions updated; `skills/dream-rsi-loop/SKILL.md`; README and CHANGELOG entries. Tests:
  `tests/extension.test.mjs` (13, including two loop-surface tests that run the real loop on a
  fixture to an empty-inventory stop with zero spawns).

Next: fixture harness for variation runs — planted-lever fixtures (Node and Python per the
`eval/fixtures` pattern), no-op control repo, held-out variants; unattended e2e runs from fresh
clones to applied verified patches; cheat/duplicate/noise/timeout scenario runs with false
applies required to stay 0; cost-per-verified-win economics; harden the campaign-scenarios
timeout margin; then independent review by gpt-6.1-sol (high) and the acceptance report.

## Progress ledger (end-to-end acceptance harness)

Unattended e2e harness `tests/loop-e2e.test.mjs` (fresh `git clone` per run; the clone must fail
before the loop and pass after the applied patch, both checked by running the fixture command
outside the loop's own measurement):

- Fixtures: `fixes` (npm, single file, repeats for cost variability), `multifix` (npm, two nested
  files), `pytest` (pyproject gate; skipped without pytest), `bunlock` (npm-test head resolved to
  `bun test` from `bun.lock` evidence; the synthesized evaluator text is asserted to carry the
  resolved argv), `noise` known-negative (in-scope no-op edit plus an out-of-scope test-file cheat;
  zero applies, working tree byte-identical where it matters, command still fails), `heldout`
  (nested multifix with extra noise signals, gated behind `DREAM_RSI_HELDOUT=1`).
- Scenario stubs run through the real loop via `taskProvider`: cheat (stopped by gate), no-op,
  regression, review rejection, duplicate (exactly one apply), timeout (at most one verified
  apply) — false applies required to stay 0.
- The control patch lives in `.dream-rsi/` in each clone (the state directory candidates never
  copy), so no stub agent can edit the calibration instrument.

Defects found and fixed while making the fixtures pass (each with a regression test):

- Windows spawn in the synthesized evaluator (`engine/metrics.ts`): `spawnSync("npm")` is ENOENT
  and `"npm.cmd"` is EINVAL, while `cmd.exe /d /s /c` with literal quote characters around the
  command is rejected (`'"npm test"' is not recognized`). Fix: path-like commands (real
  executables, including spaced paths like `C:\Program Files\nodejs\node.exe`) spawn directly; a
  bare name goes through `cmd.exe` as a plain unquoted canonical command line. Regression:
  `tests/metrics.test.mjs` runs the real resolved npm runner and requires the 3 → 0 failure-count
  variation across the fix; `npm` runs once against the real project and once via an absolute
  `process.execPath` override.
- Candidate diffs rejected runner artifacts (`engine/campaign-patch.ts`): any runner that writes a
  cache made every candidate an "out-of-scope change" (observed:
  `candidate changed path outside declared scope: .pytest_cache/v/cache/lastfailed`). Fix: the
  difference walk skips ephemeral tool artifacts at any depth (bytecode/test/dep/virtualenv/build
  caches); real out-of-scope source edits still fail closed. Regression:
  `tests/campaign-patch.test.mjs` (10 tests at the time; 11 after the review pass isolated the
  out-of-scope assertion), plus the pytest e2e fixture.

Evidence (2026-10-16, same tree):

- `node --test tests/loop-e2e.test.mjs` three-repeat sweep (`e2e-accept-3rep.out`): 13 items,
  12 pass, 0 fail, 1 skipped (held-out correctly gated), exit 0. Verified wins and cost per win:
  `fixes` 3/3 repeats (15 agent starts, 21 evaluator runs each; wall 54.0/55.5/56.0 s),
  `multifix` 1/1 (15/21; 57.2 s), `pytest` 2/2 (15/21; 73.0/78.3 s), `bunlock` 1/1 (15/21;
  42.0 s). Starts and evaluator runs are deterministic; only wall time varies with machine load.
- Held-out acceptance run (`DREAM_RSI_HELDOUT=1`, `e2e-heldout.out`): 13/13 pass, exit 0; the
  held-out fixture won on its first observation (51.1 s, 15 starts, 21 runs). That first
  observation is now used up; a rerun is variation evidence only, not a held-out control.
- Known-negative fixture and all six scenario subtests: zero false applies (duplicate = exactly
  one apply, timeout ≤ one).
- First full suite under load (`npm test`, every test file in parallel): 295 tests, 293 pass,
  1 fail, 1 skipped. The one failure was harness load-sensitivity, not a logic defect: the
  `fixes` campaign hit its 120 s internal deadline while the whole suite ran in parallel (solo
  ~55 s; under load the same campaign reached 129.5 s before the deadline cut it). Hardening
  without weakening assertions: the harness campaign deadline rises 120 s → 600 s and the
  loop-run deadline 180 s → 900 s; the assertion still demands an independently verified win.
- Independent review (gpt-6.1-sol, high reasoning; separate `pi` process, read-only tools,
  extensions and MCP disabled; full report `review-gpt61-run2.clean.md` in the session temp
  directory): confirmed both fixes above, independently re-ran 37 targeted tests, reproduced
  fail-closed defects in the loop with file-free probes, and confirmed the promotion path,
  fresh-clone-per-repeat harness, and known-negative fixture. Findings and dispositions
  (six major, four minor):
  - Fixed, with regression tests: a loop "win" could mask a failed campaign (`engine/loop.ts`):
    a failed terminal state stops the loop while the applied win is still recorded, except
    lever-level evaluator preflight rejections (also `state: failed`) which remain screening
    rejections so the loop continues to the next lever;
    budget counters accepted negative or fractional values that inflated the remaining allowance
    (`engine/loop.ts`): counters are now schema-validated as nonnegative safe integers; memory
    accepted negative counts, impossible win counts, unknown outcomes, and object-valued notes
    (`engine/search.ts`): lever stats and outcome records are now validated; the Windows shim
    path could silently reinterpret arguments (`engine/metrics.ts`): unsafe arguments now fail
    closed with `spawn_error`; the out-of-scope regression assertion was confounded by the
    shared fixture (`tests/campaign-patch.test.mjs`): replaced with an isolated tree where
    removing `other.txt` makes the same call pass.
  - Reported, not changed (design decisions or pre-existing engine behavior): campaign spending
    is recorded only after `runCampaign` returns, so a throw loses immediate accounting and
    concurrent loop invocations can overwrite totals — needs a reservation/reconciliation
    protocol; target drift during review is checked only for patched paths
    (`engine/campaign.ts`); cross-project loops versus stop/status use different state roots
    (`extensions/pi-dream-rsi/index.ts`); default discovery cannot turn failing-command or
    slow-command levers into campaigns and screening stops after the first four ranked
    proposals (`engine/levers.ts`); the plateau note was reworded to state the truth (a plain
    re-run repeats the same evaluation — it does not "restart fresh"), while a real plateau
    restart or cursor remains open; scenario assertions mostly check apply counts and byte
    changes, and the held-out fixture shares the marker transformation (an env gate, not an
    independent holdout).
- After the fixes: `npm run typecheck` clean; `node --test tests/loop.test.mjs
  tests/search.test.mjs tests/metrics.test.mjs tests/campaign-patch.test.mjs` 34/34 pass
  (loop 11, search 5, metrics 7, campaign-patch 11).
- Post-fix full suite under load (`full-suite-postfix.out`): 300 tests, 299 pass, 0 fail,
  1 skipped (held-out gated), exit 0. The e2e file ran at three repeats inside the loaded suite:
  `fixes` 3/3 wins (deterministic 15/15/15 starts and 21/21/21 runs; wall 51.3/94.8/188.9 s — the
  load spike that failed the pre-hardening run now passes inside the raised deadline), multifix
  1/1, pytest 2/2, bunlock 1/1, known-negative and all scenario subtests at zero false applies.
- Repo integrity after all runs: file manifest 560 files before and after; only the intended
  edited files differ; branch `codex/dream-rsi-2` and HEAD `3da5a8c` unchanged; no commits and
  no stashes were made.

## Gap closure after independent review (2026-10-17)

Every item in the review's "reported, not changed" list above is now closed, each with a
regression test, and the e2e harness was strengthened along the same axes:

- Budget reservation and reconciliation (`engine/loop.ts`): the granted budget is written to
  `.dream-rsi/loop/budget.json` as `open_campaign` before `runCampaign` starts and reconciled
  after it returns. A campaign that throws now charges its full grant (this supersedes the
  earlier "spends nothing" behavior); a leftover reservation from a killed run is charged once
  on the next read. Legacy budget files without the new fields are adopted, corrupt values fail
  closed. Tests: `tests/loop.test.mjs` (14 total).
- Single-writer lease (`engine/loop.ts`): `loopRoot/lease.json` {pid, startedAt, heartbeatAt}
  with a heartbeat per iteration. A fresh lease (heartbeat under 45 minutes old — the default
  campaign deadline is 30 minutes) stops the second run with `blocked` and a note naming the
  holder; a stale lease is taken over with a note; a corrupt lease counts as stale. Released in
  `finally`. Tests: `tests/loop.test.mjs`.
- Review-window workspace fingerprint (`engine/campaign-patch.ts`, `engine/campaign.ts`):
  exported `workspaceDigest` hashes every candidate-visible path, content hash, and mode; the
  campaign takes it before adversarial review and rejects the candidate when it changed
  afterwards outside the re-verified patch paths (previously only patched paths were checked).
  The digest and the patch builder share one cache-visibility basis. Tests:
  `tests/campaign-patch.test.mjs` (14 total).
- Cache visibility narrowed to git evidence (`engine/campaign-patch.ts`): the difference walk
  skipped all cache-like directories, so an agent edit inside a tracked `target/` or committed
  `node_modules/` vanished from the patch and the scope check. The skip now applies only to
  cache paths without tracked files (`git --literal-pathspecs ls-files` in the target), with
  presence-in-seed as the documented fallback when git evidence is unavailable. This replaced a
  first presence-only cut that the acceptance sweep caught: the harness's own broken-before run
  left an untracked `.pytest_cache` in the clone, presence read it as committed content, and
  every pytest candidate was rejected (`candidate changed path outside declared scope:
  .pytest_cache/v/cache/lastfailed`). Regression: the git-evidence unit test plus the pytest
  fixture. Tests: `tests/campaign-patch.test.mjs`.
- Scope discovery for command levers (`engine/signals.ts`, `engine/levers.ts`): sessions record
  the files edited within three tool calls after each failing or slow command; those paths
  become `scopeHints` and failing/slow-command levers campaign with exactly that scope — never a
  blanket `["."]`. The screening `slice(0, 4)` cap is removed so no lever is silently
  unreachable. Tests: `tests/signals.test.mjs` (14), `tests/levers.test.mjs` (5).
- Plateau restart (`engine/loop.ts`, `engine/metrics.ts`): a plateaued lever restarts once
  through its alternate metric kind (`command-success` ↔ `command-duration`,
  `suite-failures` → `command-duration`) via `SynthesizeMetricOptions.metricOverride`, bounded
  by durable `max_restarts` (default 1; legacy budgets adopt it). An alternate that
  preflight-rejects is recorded honestly and the loop then stops on plateau. `search.ts` also
  fixed a `plateauState` quirk where a mixed three-or-more-lever streak resurrected the oldest
  lever as the plateau owner (now ownerless). Tests: `tests/loop.test.mjs`,
  `tests/search.test.mjs` (5).
- Project-keyed loop state (`extensions/pi-dream-rsi/index.ts`): `dream_rsi_loop` start and
  status resolve `project_dir` and key all state and progress callbacks to that project's
  `.dream-rsi`, not the calling directory. Tests: `tests/extension.test.mjs` (14).
- E2E strengthening (`tests/loop-e2e.test.mjs`): win assertions now require ledger stage
  evidence (apply success, review accept, paired confirm success, attempts with observed
  edits); the known-negative fixture asserts the cheat ran as a live attempt and was rejected
  by scope with `test.mjs` named; scenario runs assert the gate/review rejection stages, the
  timed-out attempt with `editCount > 0`, and duplicate-title counting; a real-engine
  preflight-continuation test supplies a control patch that cannot beat the baseline and
  asserts two rejected campaigns with zero agent starts, `control-rejected` ledger entries, and
  a budget stop rather than an early abort; the held-out fixture keeps its fixed instance and
  adds a seeded-randomized instance (mulberry32; seed from `DREAM_RSI_HELDOUT_SEED` or random,
  reported via test diagnostics) with randomized directories, file names, marker text, and
  package name.

Acceptance evidence (2026-10-17, tree `codex/dream-rsi-2`, uncommitted; log
`e2e-accept-final-v2.out` in the session temp directory):

- Fresh-clone sweep `DREAM_RSI_LOOP_E2E_REPEATS=3 DREAM_RSI_HELDOUT=1
  DREAM_RSI_HELDOUT_SEED=739201846 node --test tests/loop-e2e.test.mjs`: 15 items, 15 pass,
  0 fail, 0 skipped. Every verified win cost 15 agent starts and 21 evaluator runs; wall
  min/median/max: `fixes` 51.0/51.6/51.7 s (3 repeats), `multifix` 51.4 s, `pytest`
  56.2/59.4 s (2 repeats), `bunlock` 20.3 s, `heldout` 36.3 s, `heldout-random` 36.0 s.
  Both held-out instances won on their first observation with seed 739201846 (this seed is now
  used up).
- Full suite (`npm test`, every file in parallel; `full-suite-final-v2.out`): 310 tests,
  308 pass, 0 fail, 2 skipped (both held-out gates, run green in the sweep above), 529.7 s,
  exit 0. `npm run typecheck`: clean.
- Unit counts after closure: loop 14, search 5, signals 14, levers 5, campaign-patch 14,
  metrics 7, extension 14.
- Boundaries unchanged: no commit, push, merge, publish, or scheduler install; applied patches
  stay uncommitted in the clone's working tree; the repository working tree keeps the
  pre-existing WIP.

## Second review round (2026-10-17)

A second independent review (`gpt-6.1-sol`, high reasoning, read-only separate process; report
`review-gpt61-run3.out` in the session temp directory) re-checked the remediation above and
returned six findings: two High, three Medium, one Low. All six are closed, each with a
regression test:

- Lease accounting (High). The lease was read-then-written, so two simultaneous starts could
  both claim it, and budget loading plus leftover-reservation reconciliation ran before the
  lease check, so a blocked invocation could charge the active owner's budget. The claim is now
  one exclusive file creation (`open` with `wx`), a stale lease is removed and the claim retried
  (bounded), and budget loading and reconciliation happen only after the claim. Only the current
  holder (pid plus start time) removes the lease on exit. Tests: a blocked run leaves the
  owner's budget byte-identical including its open reservation; an overlapping second loop loses
  the claim while the first is inside a gated campaign.
- Tracked cache shapes (High). Cache-visibility discovery stopped at the first cache-like
  directory and considered only directories, so a tracked `target/node_modules/...` or a
  tracked file named like a cache (`src/target`) stayed invisible to both the patch builder and
  the review-window digest. `visibleCachePaths` now registers cache-shaped paths at any depth
  and in either shape, deciding by git trackedness with presence-in-seed as the fallback.
  Tests: the git-evidence unit test covers the nested and file-shaped cases in the patch and in
  the digest; the pytest e2e keeps the untracked-cache case green.
- Cross-project stop (Medium). The session retains the last loop target (`pi-dream-rsi/loop-target`
  entry); `/dream-rsi stop`, `/dream-rsi status`, and `dream_rsi_improve action=stop` fall back to
  that project when the calling directory has no campaign, and the report names the target.
  Test: a loop started on project B, a running campaign fabricated under B, and the command run
  from A writes `stop.request` under B and reports the loop target.
- Scenario assertions (Medium). The no-op and regression scenarios now require stage evidence
  (a live attempt with zero observed edits for no-op and observed edits for regression, plus a
  `candidate-score` rejection naming the no-gain reason); an applied timeout patch additionally
  requires a review-accept entry and a positive paired confirmation.
- Corrupt restart counter (Medium). `restarts: null` is corruption, not legacy absence: it now
  fails closed, and the tamper list covers it.
- Thrown-campaign count (Low). A launched campaign that throws counts in the run's campaign
  total, even though it has no campaign root.

Boundaries the review questioned, answered by design and documented here rather than changed:

- The workspace digest covers the adversarial-review slot. From verification through apply, the
  patched paths are guarded by preimage checks and a byte-equality check, and gates run in
  scratch copies; content outside the patch cannot change the applied bytes, so a digest check
  there would reject candidates for unrelated committed drift without protecting anything.
- Overlapping failure windows in signal discovery can give one edit path to two command levers.
  Scope attribution is permissive: a shared edit only widens the scope of the lever the loop
  campaigns for, and the scope check still contains every candidate to the declared files.
- The held-out fixtures are variation evidence, not independent discovery: the stub agent
  receives the replacement mapping by construction. They guard the pipeline and the harness
  against fixture-specific overfitting, and the randomized instance re-draws directories, file
  names, marker text, and the package name from its seed.

Acceptance evidence after this round (logs `e2e-accept-final-v3.out`, `full-suite-final-v3.out`):

- `DREAM_RSI_LOOP_E2E_REPEATS=3 DREAM_RSI_HELDOUT=1 DREAM_RSI_HELDOUT_SEED=615204877 node --test
  tests/loop-e2e.test.mjs`: 15 items, 15 pass, 0 fail, 0 skipped. Every verified win cost 15
  agent starts and 21 evaluator runs; wall min/median/max: `fixes` 32.3/32.3/33.1 s,
  `multifix` 32.9 s, `pytest` 50.9/52.1 s, `bunlock` 19.2 s, `heldout` 32.8 s,
  `heldout-random` 31.3 s (seed 615204877, now used up).
- `npm test`: 313 tests, 311 pass, 0 fail, 2 skipped (the held-out gates), 480.4 s, exit 0.
  `npm run typecheck`: clean.
- Unit counts: loop 16, search 5, signals 14, levers 5, campaign-patch 14, metrics 7,
  extension 15.

## Third review round (2026-10-17)

The same independent verifier checked the closures above with its own probes (report
`review-gpt61-run4.clean.md`, same temp directory). It confirmed five of six closures and
refuted the lease closure with two counterexamples; it also held the verification-to-review
digest window open rather than accepting the documented boundary. All three are now closed:

- Lease publication race (High, confirmed counterexample). `open("wx")` created the file
  before writing its content, so a contender catching that moment read an empty file, called
  it stale, removed it, and claimed the lease while the first process still held it. The
  lease is now published as one atomic hard link of a fully written file (`claimLease`):
  contenders either see the complete lease or no lease. Where hard links are unavailable, the
  exclusive-create fallback is covered by a 30-second publish grace — an unreadable lease file
  younger than the grace is reported as a publication in progress and never taken over, while
  an unreadable file past the grace is a crashed writer and is taken over (bounded retries).
  Tests: a half-published empty lease file blocks the second loop and is left alone; the same
  file with an hour old mtime is taken over and the loop proceeds.
- Blocked-writer memory race (Medium, confirmed counterexample). A blocked invocation loaded
  loop memory before attempting the lease and then persisted its stale snapshot after the
  holder had written newer notes, erasing them. Blocked invocations now build their note in
  the returned state only (`noteLocally`) and persist nothing: no budget write, no memory
  write. Test: the blocked-budget test now also asserts memory.json is byte-identical after
  the blocked run while its result still names the blocking pid.
- Verification-window digest (boundary, not accepted as closed). A candidate-visible path
  outside the patch could change between paired verification and the review digest, so a
  verified patch could be applied onto content the measurement never saw. The digest is now
  taken once before confirmation and compared again before apply, alongside the review-window
  digest, with a distinct rejection ("target workspace changed during candidate verification
  outside the re-verified patch paths"). Test: a clean gate that changes an unpatched
  dependency in the live workspace during promotion — the candidate has a successful
  confirmation pair in the ledger and is still rejected before apply, leaving the seed
  workspace untouched.

Acceptance evidence after this round (logs `e2e-accept-final-v4.out`, `full-suite-final-v4.out`):

- `DREAM_RSI_LOOP_E2E_REPEATS=3 DREAM_RSI_HELDOUT=1 DREAM_RSI_HELDOUT_SEED=481920336 node --test
  tests/loop-e2e.test.mjs`: 15 items, 15 pass, 0 fail, 0 skipped. Every verified win cost 15
  agent starts and 21 evaluator runs; wall min/median/max: `fixes` 33.0/33.7/36.2 s,
  `multifix` 33.7 s, `pytest` 52.6/53.2 s, `bunlock` 19.2 s, `heldout` 33.8 s,
  `heldout-random` 33.4 s (seed 481920336, now used up).
- `npm test`: 315 tests, 313 pass, 0 fail, 2 skipped (the held-out gates), 492.1 s, exit 0.
  `npm run typecheck`: clean.
- Unit counts: loop 17, search 5, signals 14, levers 5, campaign-patch 14, metrics 7,
  extension 15, campaign scenarios 11.

## Fourth review round (2026-10-17)

The verifier replayed its counterexamples against the round-3 closures (report
`review-gpt61-run5.clean.md`). All three closures are **confirmed**: every synthetic lease
interleaving (before the link, after the link, and the exclusive-create fallback mid-write)
launched exactly one campaign and persisted exactly one charge; an unreadable one-second-old
lease blocked while the same shape past the grace was taken over and a future mtime stayed
blocked; a blocked invocation left budget and memory byte-identical while its returned copy
named the blocking pid, and the previously destructive read-then-block ordering preserved the
holder's later outcomes and note; the verification-digest matrix rejected persistent unpatched
drift and tracked-cache drift and correctly ignored restoration, excluded files, untracked
caches, and patch-covered changes to unrelated bytes.

One **new Medium regression** was confirmed and is closed: the whole-tree digest compared
patched paths too, so an actor installing a patch path's exact verified postimage during
verification was rejected as drift even though `patchConflicts` and
`assertPatchBytesUnchanged` deliberately tolerate that idempotent-postimage case — the
promotion was refused with the verified improvement already present in the live tree. Both
digest comparisons now exclude the patch's own paths (`digestExcludes`); patched-path
integrity remains governed by the preimage, byte-equality, and conflict checks at apply time.
Test: a clean gate that installs the exact verified postimage into the patched path from the
patched scratch — the promotion applies, and no drift rejection is recorded.

Acceptance evidence after this round (logs `e2e-accept-final-v5.out`, `full-suite-final-v5.out`):

- `DREAM_RSI_LOOP_E2E_REPEATS=3 DREAM_RSI_HELDOUT=1 DREAM_RSI_HELDOUT_SEED=260714885 node --test
  tests/loop-e2e.test.mjs`: 15 items, 15 pass, 0 fail, 0 skipped. Every verified win cost 15
  agent starts and 21 evaluator runs; wall min/median/max: `fixes` 31.4/31.5/33.8 s,
  `multifix` 30.7 s, `pytest` 48.5/50.9 s, `bunlock` 17.9 s, `heldout` 38.9 s,
  `heldout-random` 36.5 s (seed 260714885, now used up).
- `npm test`: 316 tests, 314 pass, 0 fail, 2 skipped (the held-out gates), 646.9 s, exit 0.
  `npm run typecheck`: clean.
- Unit counts: loop 17, search 5, signals 14, levers 5, campaign-patch 14, metrics 7,
  extension 15, campaign scenarios 12.
- Residual uncertainty stated by the verifier: the lease interleavings are controlled
  synthetic schedules, not exhaustive multiprocess scheduling; unsupported-link behavior was
  injected; endpoint digests do not prove the absence of a transient change during
  measurement; the heavy acceptance logs were inspected, not independently rerun.

## Fifth review round (2026-10-17; independent run 6)

The independent reviewer reran acceptance on seed `915724638`: 15/15 passed, 0 skipped, in
470.5 s. Its focused set passed 61/61. It also found defects that those passes did not cover:

- **High — stale lease reapers could delete a newer owner's lease.** Two processes could both
  observe a dead stale lease. One paused before unlink, the other removed it and acquired a new
  lease, then the first unlinked the new lease and entered another campaign. Three real-process
  schedules reproduced overlapping campaigns and reservation reconciliation. The existing
  fresh-start test did not cover stale reaping.
- **Medium — drift after the final digest but before apply could be applied.** A controlled
  filesystem hook changed an unpatched dependency during persistence of `pendingApply`. The
  apply was recorded, but an independent evaluator found the result invalid. This is a
  post-gate boundary race, not a failure of the idempotent-postimage digest exclusion.
- **Low — the fallback test did not require exclusive create.** Replacing `open(..., "wx")` with
  `open(..., "w")` survived the original test; a forced two-process collision reproduced two
  campaigns.
- **Low — the atomic rename test did not pin fatal-error retry count or total attempt bound.**
  Production behavior passed the reviewer's injected matrix, but retry-fatal and five-attempt
  mutants survived the submitted test.

The reviewer also independently reran the held-out acceptance sweep and confirmed its fixture
assertions for positive, negative, duplicate, noise, timeout, gate, review, and preflight cases.
The report is `%TEMP%/opencode/review-gpt61-run6.out`; its acceptance log is
`%TEMP%/opencode/review-run6-sweep.out`.

## Sixth review round (remediation; 2026-10-17)

Closures for all four run-6 findings:

- **Stale lease recovery is serialized.** Before removing a stale lease, a contender must claim
  the exclusive sibling `lease.json.recovery`, re-read the lease, and confirm that its owner is
  on this host and its PID is no longer alive. A live or unverifiable owner blocks. The recovery
  claim remains held until the replacement lease is published. A crash during reaping leaves a
  blocking recovery claim; after confirming its recorded process is not running, inspect and
  remove that file manually. Tests cover a live process with an old heartbeat, a dead-owner
  takeover, and two processes paused around stale unlink. Mutating away the recovery claim makes
  the stale-reaper regression fail.
- **Apply checks the workspace again at its transaction boundary.** The expected digest and
  existing exclusions travel into `applyCandidatePatch`; the helper checks before journaling and
  after patch writes. A mismatch after writes rolls back the patch. The campaign clears
  `pendingApply`, records an apply-stage rejection, and stops the campaign. A child-process test
  changes an unpatched dependency during `pendingApply` persistence; no patch is applied, the
  external edit remains, and disabling the digest check makes the test fail. Arbitrary external
  writers do not honor a lock, so a mutation after the post-write digest remains a narrow
  non-atomic filesystem boundary; the code and changelog do not claim full protection against
  that schedule.
- **Fallback race coverage now forces two processes to observe an absent lease before either
  calls exclusive create.** Exactly one campaign and one durable charge are required. The
  `wx`-to-`w` mutation fails this regression.
- **Atomic rename tests assert both error policy and bounds.** Fatal `ENOENT` is attempted once;
  persistent `EPERM` stops after four calls with waits `[5, 10, 15]`, preserves the old target,
  and removes the temporary file. Retrying fatal errors or allowing a fifth attempt fails tests.

Evidence on the modified tree (HEAD remains `3da5a8c`, changes remain uncommitted):

- `npm run typecheck`: clean.
- Focused suite (`loop`, `campaign-patch`, `campaign-scenarios`, `extension`): 64 tests,
  64 pass, 0 fail, 0 skipped.
- Full `npm test`: 322 tests, 320 pass, 0 fail, 2 expected held-out skips, 663.2 s.
- Fresh-clone acceptance sweep with `DREAM_RSI_LOOP_E2E_REPEATS=3`, held-out enabled, seed
  `843092715`: 15/15 pass, 0 fail, 0 skipped, 577.8 s. Verified wins used 15 agent starts and
  21 evaluator runs. Repeated wall ranges: npm fixes 43.4–47.9 s; pytest 63.8–69.0 s. Other
  observed wins: multifix 39.8 s, bunlock 23.3 s, nested held-out 40.8 s, randomized held-out
  40.1 s. Logs: `e2e-accept-final-v8.out` and `full-suite-final-v8.out` in the session temp
  directory.
- Mutation controls: the stale-reaper, fallback exclusivity, apply-digest, fatal-retry, and
  four-attempt bounds each fail when their corresponding protection is removed. Mutated files
  were restored byte-identically.

Remaining boundary: an uncooperative writer can still change an unpatched file after the final
post-write digest check. No portable multi-file filesystem transaction exists here; the
promotion journal can roll back the candidate patch, but cannot prevent unrelated external
writes. Stale recovery claims left by a killed reaper also need manual inspection as described
above. Independent run-7 review is pending.

## Seventh review round (2026-10-17; independent run 7)

The independent reviewer found two additional defects and confirmed one operational limitation
(report `%TEMP%/opencode/review-gpt61-run7.out`):

- **P1 — absent-primary race during stale recovery.** A reaper could hold the recovery claim,
  observe that the old process had released the primary, then unlink a new primary published
  before its `rmSync`. This was reproduced with three real processes. The stale-reaper mutex
  alone did not serialize ordinary primary publication.
- **P2 — valid deletion patches failed the post-write digest.** Promotion renames a deleted
  target to a transaction tombstone. The final workspace digest saw that generated sibling file
  as unpatched drift, so update-and-delete candidates rolled back even without an external
  writer.
- **P2 operational limitation — orphan recovery claim.** If a process dies while holding the
  recovery claim and the stale primary still exists, later stale takeovers block until a human
  verifies and removes the claim. A timeout cannot safely steal it because the reaper may only
  be paused. This is documented as an explicit fail-closed recovery procedure, not claimed as
  fully unattended crash recovery.

Closures for the two reproduced defects:

- When a reaper's second read finds the primary absent, it now tries an exclusive primary claim;
  it never unlinks that absent path. A concurrent publisher wins atomically or the reaper wins.
  An existing but old unreadable lease is also preserved because the owner cannot be verified.
  Regression: real O/A/C process schedule (old owner exits normally; reaper pauses after seeing
  absence; new owner claims; reaper resumes and must block). The unconditional-unlink mutation
  fails this test.
- The apply digest excludes only the transaction's exact generated deletion tombstone paths,
  after checking those paths do not already exist. It does not hide arbitrary files with a
  similar suffix. Integrated test verifies an update and a delete commit in one promotion; the
  tombstone-exclusion mutation fails it.

Latest evidence after these fixes (working tree uncommitted, HEAD remains `3da5a8c`):

- `npm run typecheck`: clean.
- `tests/loop.test.mjs`: 23/23 pass. `tests/campaign-scenarios.test.mjs`: 14/14 pass.
- `npm test`: 324 tests, 322 pass, 0 fail, 2 expected held-out skips, 685.1 s; log
  `full-suite-final-v9.out`.
- Fresh-clone acceptance with repeats=3, held-out enabled, seed `864213957`: 15/15 pass,
  0 fail, 0 skipped, 584.9 s; log `e2e-accept-final-v9.out`. Each verified win used 15 agent
  starts and 21 evaluator runs. Repeated wall ranges: npm fixes 38.3–44.6 s; pytest
  69.8–80.8 s. Other wins: multifix 43.7 s, bunlock 34.4 s, nested held-out 36.3 s,
  randomized held-out 37.5 s.
- Mutation checks: adding an unlink after the absent-primary observation makes the three-process
  regression fail; removing transaction tombstone exclusion makes the update-and-delete test
  fail. Tests also preserve the earlier run-7 fallback, rename, and apply-drift mutation evidence.

The independent review above examined the prior remediation and found the two defects now fixed;
independent review of this latest delta is pending. The orphan recovery claim and the final
post-write external-writer boundary remain disclosed operational/safety limits.
