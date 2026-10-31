# Set-and-forget RSI: product first, evidence second

**Status:** v2 rewrite. Baseline: `dream-rsi/improve` at `81de5f3`. Plan only; no code. The previous version was a 5-9 month research program. This version uses [`pi-autoresearch`](https://github.com/davebcn87/pi-autoresearch) as the shape and Elon Musk's five-step algorithm as the filter.

**Decision:** ship a thin, pi-driven loop in about 2 weeks; add the repository trust layer in about 3 weeks; run a 6-repository evidence pilot in 4-6 weeks. The 16+4 held-out claim stays available, but it is a separate, optional track. Do not automate before deleting and simplifying.

## 1. The five laws, applied

The five steps, in order: (1) make requirements less dumb, (2) delete any part or process you can, (3) simplify and optimize, (4) accelerate cycle time, (5) automate last. The order matters. The old plan violated step 3: it optimized a process that should not exist for the product.

| Law | What it changes in this plan | Result |
| --- | --- | --- |
| 1. Question requirements | "Arbitrary repository" becomes "a trusted repository the operator would run by hand." "Provider-enforced spend" becomes "provider key cap plus an experiment cap" for v1. "Multi-OS supervisor" becomes "pi session plus resume from the log." "Self-improvement" is not a v1 requirement. "Magnitude claim" moves to the optional evidence track. Every remaining requirement has an owner: the operator (goal, metric, command, scope), the provider (key cap), pi (session), or Dream-RSI (verified commit). | Two requirements deleted (multi-OS supervisor, self-improvement), two narrowed (arbitrary repository, provider-enforced spend), one moved to an optional track (magnitude claim). |
| 2. Delete | Delete the RSI controller, the Node/Python harness generator, oracle synthesis and mutation testing, the provider proxy and container, the supervisor and intent journal, multi-OS service units, the timed post-commit monitor, the portfolio/archive/predictor, cross-repository transfer and policy learning, review-branch finalize, and the 20-repository harbor from the critical path. | About 70% of the previous plan is gone from the product path. |
| 3. Simplify | Three loop tools plus a read-only status tool, one state folder, one measure command, one required checks command, one metric, one branch. Reuse the existing verified commit and correctness-gate path. The agent is the search policy; the tools measure, verify, commit, and revert. | The loop is `pi-autoresearch` plus Dream-RSI's commit and gate guarantees. |
| 4. Accelerate | Two-week MVP. One experiment per cycle. No approval inside the loop. Resume from the log after a pi restart. The agent reads `prompt.md` and the log tail, not the whole history. | First useful run in days, not months. |
| 5. Automate | Automate only `run -> log -> commit/revert`. Service/timer install is last. Push and merge are never automated. | Automation follows proof, not the reverse. |

The old plan's biggest mistake was treating the evidence program as the product. It is not. The product is a loop an operator can use this month. The evidence program is how you earn the right to make a magnitude claim later.

## 2. What the product is

One pi session, one repository, one folder, three loop tools, and one read-only status tool.

The operator starts with a goal, a metric, a command that prints the metric, at least one correctness check, and a scope. The agent edits code; the tools run the command, check correctness, keep or revert, and commit only a verified win on a dedicated branch. The loop stops at a configured experiment count, after K consecutive discards, or when the provider refuses further calls at the key cap. A fresh pi session resumes from `.dream-rsi/auto/log.jsonl`.

**Product claim (v1):** on a trusted local repository, with a declared metric and command, at least one correctness check, a clean working tree, a dedicated branch, and a provider key cap, `/dream-rsi auto` runs experiments continuously, keeps only changes that pass the checks and beat the metric, commits them locally, reverts failed experiments, and resumes from the log. It does not push, merge, or claim a magnitude.

**Non-claims:** not for untrusted repositories; no per-call spend enforcement; no boot persistence; no post-commit monitor; no arbitrary-repository magnitude; no self-improvement.

### 2.1 Four tools and one folder

| Tool | Does | Refuses |
| --- | --- | --- |
| `dream_rsi_auto_init` | Records goal, metric, unit, direction, command, checks, scope, minimum gain, experiment cap, consecutive-discard cap, and branch. Runs a smoke qualification: five baseline readings, CV check, one passing check run, scope safety. Writes state; creates the branch. | Dirty tree, protected path, no check command, CV above threshold, command that does not run. |
| `dream_rsi_auto_run` | Runs the declared command, captures the reading and output, records the pre-run diff. No commit. | No active session, command changed, out-of-scope diff. |
| `dream_rsi_auto_log` | Reads the last run. If checks pass and the metric clears the minimum gain (with the existing paired confirmation for noisy metrics), commits only the verified patch; otherwise restores the experiment's scope to the last kept commit. Appends `log.jsonl`, updates `prompt.md`. | Missing run, unverified patch, branch drift. A failed check is a discard, not a stop. |
| `dream_rsi_auto_status` | Reads the log and config; prints runs, best metric, confidence, spend, branch, and the next action. | Nothing. It is read-only. |

State lives in `.dream-rsi/auto/`:

| File | Purpose |
| --- | --- |
| `prompt.md` | Objective, scope, metric, tried ideas, dead ends, next ideas. The resume document. |
| `measure.sh` | The command the agent writes. Any language. No harness generator. |
| `checks.sh` | Tests, types, lint. Required for auto-commit. |
| `log.jsonl` | Append-only: run, metric, status, commit, description, hypothesis, confidence. |
| `config.json` | Experiment cap, consecutive-discard cap, minimum gain, provider cap, branch, scope. |

The loop:

```text
init -> baseline -> [agent edits -> run -> log -> keep or discard] -> stop
```

The agent reads `prompt.md` and the log tail at the start of every turn. It proposes the next idea, edits within scope, calls `run`, then `log`. The loop is the agent's own turn cycle. pi's compaction is enough; there is no separate supervisor.

### 2.2 Keep, discard, resume

- **Keep:** checks pass, the metric clears `minimum_gain`, and the patch is inside scope. For noisy metrics, `log` runs the existing paired confirmation before committing; for deterministic counters, one reading is enough. Commit with the existing dedicated-branch and postimage checks. The commit message includes the metric and the evidence path.
- **Discard:** restore tracked changes in the experiment's scope to the last kept commit and remove untracked files created inside that scope. Never `git reset --hard`. Unrelated changes are refused at init, so discard is limited to the declared scope.
- **Failed check:** discard the experiment and continue. K consecutive discards stop the loop. A failed check is not a fatal stop.
- **Stop:** experiment cap, K consecutive discards, provider cap rejection, branch drift, or operator interrupt via `/dream-rsi auto off`. `off` stops at the next boundary; an in-flight run finishes and is logged.
- **Resume:** a new pi session runs `/dream-rsi auto resume`. It reads `prompt.md`, the log tail, and `git log`; it does not need the old conversation.
- **Confidence:** the paired confirmation is the keep gate for noisy metrics. The MAD/confidence number in the log is for the operator; it is not a second gate.

## 3. Stage 1 — the loop (about 2 weeks)

**User-visible behavior:** `/dream-rsi auto` starts a session on a fixture repository. The agent edits, measures, and logs. Status shows the best metric, run count, confidence, and branch. A discarded experiment leaves the tree at the last kept state. A restarted pi session resumes from the log.

**Mechanisms and files:** new `extensions/pi-dream-rsi/engine/auto.ts`; new tools in `extensions/pi-dream-rsi/index.ts`; `extensions/pi-dream-rsi/engine/git.ts` commit path on a fixture branch (Stage 2 adds `ensureAutoCommitBranch` and the repository contract); `extensions/pi-dream-rsi/engine/campaign-patch.ts:372` reused for the gate runner; `extensions/pi-dream-rsi/engine/measure.ts:271-360` reused for the paired confirmation. A fixture under `examples/autoresearch/`. Tests under `tests/auto.test.mjs`.

**Safety and claim boundary:** fixture only; no real repository, no provider spend, no trust claim. Stage 1 proves the loop mechanics. The init refusal list in §2.1 is the final Stage 2 contract: dirty-tree, protected-path, default-branch, and provider-cap guards are implemented and proven in Stage 2. Stage 1 uses a test branch created by the fixture.

**Proof:** on the fixture, 10 experiments produce at least one verified win; a failed check discards and continues; a discarded experiment restores the last kept tree and removes its untracked files; a killed pi session resumes from the log; `/dream-rsi auto off` stops after the current run and preserves the log; the log is append-only; `npm run typecheck`, `npm test`, `DREAM_RSI_HELDOUT=1 npm test`, and `npm pack --dry-run` pass.

**Cost and wall clock:** 2 engineer-weeks; $0 in infrastructure; 2 weeks.

**Failure modes:** the measure command is noisy or wrong; the agent thrashes without new ideas; the check is too weak; a discard conflicts with unrelated work; the log grows without bound; pi compaction loses the current idea.

**Rollback:** `git revert` the stage commits. The new mode is opt-in and has no effect on the existing loop. State files are versioned and ignored if unknown.

## 4. Stage 2 — the trust layer (about 3 weeks)

**User-visible behavior:** the operator sees the provider key cap and the experiment cap before the first run. The loop refuses a repository with no check, a dirty tree, a protected path, or an out-of-scope edit. A failed check never commits. The branch is always `dream-rsi/auto` or a declared dedicated branch. A secret-shaped value is redacted from the log and the commit message. If the provider refuses a call at the key cap, the loop stops with a clear message.

**Mechanisms and files:** extend `intake.ts` with an `auto` contract: goal, metric, command, checks, scope, protected assets, experiment cap, consecutive-discard cap, provider cap. Reuse `ensureAutoCommitBranch` and `commitVerifiedChanges` (`git.ts:113-124` for the branch refusal and `git.ts:207-336` for the commit), `restrictedEnvironment`, and `pathProtected`; reuse `verifyPostApply` (`verify.ts:182-274`) for the independent post-apply check before commit. Add provider rejection handling: cap/quota errors stop immediately; transient 429/5xx errors get bounded retries and then stop. Add `docs/autoresearch.md`.

**Safety and claim boundary:** trusted-local execution, explicitly stated. No container and no provider proxy in v1; the provider key cap is the spend boundary, not a per-call ceiling. Do not run on an untrusted repository or a shared host. A container or proxy is a later trust upgrade, not a v1 promise.

**Proof:** a simulated cap rejection stops the loop with a cap-specific message; a simulated transient error retries the bounded number of times and then stops; a missing check refuses auto-commit; an out-of-scope write is refused; a default-branch target is refused; a secret-shaped string is redacted; a failed post-apply check discards and leaves no commit; a branch drift stops the loop. `npm run typecheck`, `npm test`, and `git diff --check` pass.

**Cost and wall clock:** 3 engineer-weeks; $0 in infrastructure; 3 weeks.

**Failure modes:** the provider does not enforce the key cap; a transient 429/5xx is misclassified as cap exhaustion; the model bill grows faster than the experiment cap; a check is too slow; a scope is too wide; the operator uses an untrusted repo anyway.

**Rollback:** `git revert` the stage commits. The existing loop and contract behavior stay unchanged. A saved auto contract is ignored by older versions.

## 5. Stage 3 — the evidence pilot (4-6 weeks)

The pilot is the cheapest way to learn whether the loop finds real gains. It is not the full claim.

**Pilot:** 6 operator-trusted repositories, 3 development and 3 held-out, at least 5 languages. Pinned SHAs, declared metric, pinned command, one check, 5 experiments per repository. The pilot uses the same command, environment, and budget across both splits; there is no container in v1. The pilot's 6 repositories are a separate sample and are not reused in the full 16+4 harbor. The full harbor's 6 held-out repositories stay sealed and untouched.

**Pilot pass:** at least 1 of 3 held-out repositories produces a verified ratio of 2x or more; zero correctness regressions; zero commits on the negative-control fixture; 100% clean-checkout replay of accepted commits; evaluator CV at or below 5% wall clock and 1% deterministic; cost within the $1,500 pilot cap. If the pilot fails, publish the negative result and stop. If it passes, decide whether to fund the full 16+4 track.

**Mechanisms and files:** `harbor/pilot.json`, `harbor/validate.mjs`, `harbor/run.mjs`, `harbor/analyze.mjs`, and `harbor/negative-controls/`. The pilot uses the same `auto` mode; it does not add a new engine.

**Safety and claim boundary:** the pilot is evidence, not a product promise. A pass permits a larger study; it does not permit an arbitrary-repository claim. The pilot's negative controls have no headroom; any commit is a failure.

**Proof:** `node harbor/validate.mjs --frozen`; `node harbor/run.mjs --pilot`; `node harbor/analyze.mjs --pilot`; the report, log, and replay evidence are committed; `npm test` and `npm run typecheck` pass.

**Cost and wall clock:** 4-6 engineer-weeks; $500-$1,500 in model and compute; 4-6 weeks.

**Failure modes:** too few wins to learn anything; a noisy metric; a repository that cannot be qualified; an underpowered result; the pilot is mistaken for the full claim.

**Rollback:** the pilot is evidence; do not delete a negative result. `git revert` only the report commit if the report is wrong. Do not rerun to improve the result.

## 6. What was deleted

| Deleted from the product path | Why | Add back when |
| --- | --- | --- |
| RSI mode unblock | The product does not need the blocked formal mode; `auto` is a separate path. | The trust layer is proven and an operator wants RSI-mode parity. |
| Node/Python harness generator | The agent writes `measure.sh`; the language limit disappears. | A generated harness is needed for a repo with no runnable command. |
| Oracle synthesis, mutation testing, flake screening | A declared check plus the existing gate path is enough for v1. | A public "verified magnitude" claim is funded. |
| Provider proxy and container | A key cap and trusted-local consent are the v1 boundary. | The operator targets untrusted repositories or a shared host. |
| Supervisor, intent journal, multi-OS service units | pi is the host; the log is the resume state. | The operator needs boot persistence or a headless service. |
| Timed post-commit monitor | Checks run before commit; a failed check discards. | Post-commit regressions become a real observed problem. |
| Portfolio, archive, magnitude predictor | The agent's ideas and the existing ranking are enough to find wins. | The search has plateaued and a larger claim is funded. |
| Cross-repository transfer, policy learning | Not a v1 requirement. | The self-improvement claim is funded. |
| Review-branch finalize | One branch is enough; the operator reviews kept commits. | The operator needs independent review branches. |
| 20-repository harbor | A 6-repository pilot is the cheap test. | The pilot passes and the full claim is funded. |
| 5-9 month program | The product is two weeks plus a trust layer. | The evidence track is separately authorized. |

If we do not add back at least 10% of the deletions, we have not deleted enough. This table is the 10% test.

## 7. Deferred, not deleted

| Upgrade | Trigger | Approximate cost |
| --- | --- | --- |
| Provider proxy with per-call ceiling | Untrusted or shared host; real money at risk | 3-4 engineer-weeks |
| Container isolation with no egress | Untrusted repository; arbitrary-repo product | 4-6 engineer-weeks |
| systemd/launchd/Task Scheduler service | Boot persistence; headless operation | 2-3 engineer-weeks |
| Timed post-commit monitor and auto-revert | A regression found after commit | 3-4 engineer-weeks |
| Oracle synthesis and mutation testing | Public verified-magnitude claim | 4-6 engineer-weeks |
| Portfolio, archive, predictor | Search plateau; magnitude claim | 5-8 engineer-weeks |
| Transfer and policy learning | Self-improvement claim | 5-8 engineer-weeks |
| Full 16+4 held-out harbor | Pilot passes and the claim is funded | 4-6 months |

These estimates are standalone and overlap; they are not additive. The full evidence track below is the integrated estimate (5-9 months), not the sum of this table. These are not failures of v1; they are the price of claims v1 does not make.

## 8. Evidence track (optional)

The full claim stays available. It is a separate five-stage track, funded separately. This section fixes the claim, the gate, and the stage order; each stage gets its own focused plan before funding.

**Claim:** on the frozen 16+4 harbor, with 10 campaigns per held-out treatment repository, the system produces a verified 2x-or-better win on at least 4 of 6 held-out repositories, a verified-win rate of at least 30% over the 60 held-out campaigns, a magnitude-win rate of at least 15%, and a median ratio of at least 1.5 with a 95% CI lower bound above 1.15. It keeps zero correctness regressions, zero negative-control/placebo commits, 100% clean-checkout replay, 12/12 crash recoveries, evaluator CV at or below 5%, and cost at or below 250,000 tokens and $30 of treatment spend per verified win.

**Denominators:** 10 campaigns x 6 held-out treatment repositories = 60 held-out campaigns. The 10 development repositories run 10 campaigns each = 100 development campaigns; they are reported separately and do not enter the held-out rates or cost. The 4 negative controls run 10 campaigns each = 40 control campaigns. Control arms on the 10 development repositories: 5 placebo + 5 textbook + 5 shuffled each = 150 arm campaigns; 60 A/A paired sequences. These are reported separately and do not enter the held-out rates. Per-repository treatment cap: 750,000 tokens and $90 (10 campaigns, 60 minutes each).

**Harbor:** 16 treatment repositories and 4 synthetic negative controls, 10 development and 6 held-out, 8 languages. The pilot's 6 repositories are a separate sample and are not part of this harbor.

**Protocol:**

| Stage | Adds | Proof |
| --- | --- | --- |
| 1. Evaluator synthesis and qualification | Differential, property, and metamorphic oracles; mutation score >= 80%; flake screening; changed-line coverage >= 60%. | Qualification report; inert-code rejection; mutation and flake evidence. |
| 2. Provider proxy and container | Per-call output ceiling; per-run quota; egress policy; per-experiment worktrees. | Mock-provider fuzz; egress and host-file tests; worktree isolation. |
| 3. Portfolio and predictor | Multi-lever portfolio; evolutionary archive; placebo/textbook/A-A/shuffled arms; calibrated predictor. | Dev A/B; control-arm results; ECE and Brier skill. |
| 4. Supervisor, intent journal, monitor | Crash-consistent service; idempotent intent journal; post-commit monitor; `git revert`. | 12/12 kill-9 recoveries; 72-hour soak; seeded-regression revert. |
| 5. Transfer and policy learning | Leave-one-repository-out transfer; data-only policy versions; protected verifier paths. | LORO uplift CI; policy A/B; protected-path regression test. |

**Kill:** any primary endpoint misses its threshold after the full budget; any correctness regression or negative-control/placebo commit; any clean-checkout replay failure; cost above 2x the per-repository cap (750,000 tokens/$90) or the $15,000 evidence budget; fewer than 4/6 held-out breadth; any red-team success. In any of these, publish the negative result and make no claim.

**Control arms:** treatment, placebo, textbook, A/A, shuffled metric, and negative controls. **Red team:** 12 attack classes, 3 repeats, zero successes.

**Cost:** 5-9 engineer-months and $5,000-$15,000 for the integrated track; the harbor runs and upgrades overlap. This is the same work itemized in §7, not additional work.

## 9. Cost and wall clock

| Track | Engineering | Run cost | Wall clock |
| --- | --- | --- | --- |
| Stage 1: loop | 2 weeks | $0 | 2 weeks |
| Stage 2: trust | 3 weeks | $0 | 3 weeks |
| Stage 3: pilot | 4-6 weeks | $500-$1,500 | 4-6 weeks |
| Product total | 9-11 weeks | $500-$1,500 | 2-3 months |
| Full evidence (optional) | 5-9 months | $5,000-$15,000 | 5-9 months |

The product path is about one quarter. The evidence path is a separate decision.

## 10. What would prove this wrong (one page)

| Observation | Conclusion |
| --- | --- |
| 10 experiments on the fixture produce no verified win | The loop is not useful; stop before the trust layer. |
| A failed check still commits, or a discard leaves the tree dirty | The keep/revert path is wrong; do not ship. |
| A failed check stops the loop instead of discarding | The stop rules are wrong; a failure is not a fatal error. |
| A restarted pi session cannot resume from the log | It is not set-and-forget; fix or stop. |
| The operator must intervene more than once per experiment | The agent loop is not autonomous enough; simplify the task or stop. |
| An out-of-scope write, a protected-path edit, a default-branch commit, or a secret in the log | The trust boundary failed; stop and fix. |
| The provider does not enforce the key cap, or the loop cannot stop on rejection | The spend claim is false; use a provider-side hard cap or a proxy. |
| The agent needs a different custom harness for each language | The `measure.sh` simplification failed; revisit the harness generator. |
| The loop is slower or heavier than `pi-autoresearch` at the same task | The extra machinery is not paying for itself; cut more. |
| The tool works only on the fixture, not on a real repository | The qualification is too narrow; do not claim product fit. |
| The pilot produces 0 of 3 held-out 2x wins | No magnitude signal; publish the negative result. |
| Any correctness regression or negative-control commit in the pilot | The verification chain is unsafe; stop the evidence track. |
| The pilot's sample overlaps the full harbor's held-out set | The full claim is contaminated; reseal or drop the claim. |
| The pilot passes but the full track cannot be funded | The product still ships; the magnitude claim remains unproven. |
| The product path needs the full evidence program to be usable | The simplification failed; revisit the requirements. |

The single strongest product falsifier is **no verified win in 10 fixture experiments**. The most dangerous is **a commit on a failed check or a negative control**. The quietest is **a tool that is only `pi-autoresearch` with more files**. If that is what the pilot shows, delete the extra files rather than defend them.

## 11. Three claims I would still refuse without the held-out evidence

1. **"Dream-RSI finds magnitude-class improvements on arbitrary repositories."** The product loop is not the evidence track, and the harbor is a sample.
2. **"It is safe to leave unattended on untrusted repositories."** v1 is trusted-local only; the proxy and container are deferred.
3. **"Its search measurably improves itself and transfers across repositories."** That is not a v1 requirement and has no held-out evidence.

## 12. Plan-work gate

This update changes only `plans/set-and-forget-rsi.md`. Run:

1. `git status --short` — only the plan file (plus pre-existing untracked `.audit/*`).
2. `git diff --check` — exit 0.
3. `npm run typecheck` — exit 0.
4. `npm test` — 478 tests, 475 pass, 0 fail, 3 skipped (baseline).
5. `DREAM_RSI_HELDOUT=1 npm test` — 478 pass, 0 fail, 0 skipped (baseline).
6. `npm pack --dry-run` — exit 0; no `plans/` entry.
7. A fresh-context read-only review for internal consistency and any promise the tree cannot support.

The plan is not packaged. If a later stage adds `docs/autoresearch.md` to the package, add it to `package.json` `files` and update the package-content test.

## Appendix A — Tool contracts

```ts
dream_rsi_auto_init({
  goal: string,
  metric: string,
  unit: string,
  higherIsBetter: boolean,
  command: string,
  checks: string,
  scope: string[],
  protectedAssets?: string[],
  minimumGain: number | `${number}%`,
  maxExperiments: number,
  maxConsecutiveDiscards: number,
  providerCap?: number,
  branch?: string
})
```

`init` refuses when the command does not run, the check does not pass on the unmodified tree, the tree is dirty outside `.dream-rsi/`, the scope overlaps a protected path, or the baseline CV exceeds the threshold.

```ts
dream_rsi_auto_run({})
```

`run` executes the command in the declared environment, captures one reading and the output tail, and records the pre-run diff. It does not commit.

```ts
dream_rsi_auto_log({
  description: string,
  hypothesis?: string,
  status?: "keep" | "discard"
})
```

`log` reads the last run. With `status: "keep"`, it requires passing checks and the minimum gain; for noisy metrics it runs the paired confirmation before committing. Otherwise it restores the scope to the last kept commit, removes untracked files created in that scope, and appends a discard line.

```ts
dream_rsi_auto_status({})
```

`status` reads the log and config and prints runs, best metric, confidence, spend, branch, and the next action. It writes nothing.

Commands: `/dream-rsi auto`, `/dream-rsi auto resume`, `/dream-rsi auto off`, `/dream-rsi auto status`. `off` stops at the next boundary and keeps the log; `status` is read-only. There is no finalize command.

## Appendix B — Starting point and what v1 does about it

| Blocker at `81de5f3` | Evidence | v1 response |
| --- | --- | --- |
| RSI mode is accounting-only and blocks | `loop.ts:241-244`, `loop.ts:1821-1841` | New `auto` mode; RSI stays blocked. |
| No provider-enforced spend | `budget.ts:84` | Provider key cap plus experiment cap; proxy deferred. |
| No supervisor | `docs/autonomous-loop.md:19` | pi session plus log resume; OS service deferred. |
| Node/Python-only harness | `harness.ts:9`, `harness.ts:17-36` | Agent writes `measure.sh`; no generator. |
| No post-commit monitor | `docs/constitution.md:31` | Checks before commit; monitor deferred. |
| No cross-repository evidence | `.audit/rsi-checklist-matrix.md:10`, `:35` | 6-repository pilot; full harbor optional. |
| Magnitude is static | `magnitude.ts:69-172` | Paired keep decision; magnitude claim deferred. |

The product path uses the existing branch refusal and commit pipeline (`git.ts:113-124`, `git.ts:207-336`), the existing gate runner (`campaign-patch.ts:372`) and post-apply verifier (`verify.ts:182-274`), and the existing paired confirmation (`measure.ts:271-360`). It does not add a second committer or a second verifier.
