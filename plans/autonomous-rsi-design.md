# General-purpose autonomous RSI — implementation plan

## Context

Goal: point Dream-RSI at a project, identify its highest-value bottleneck, define a valid evaluation metric, run bounded experiments, apply verified improvements, and repeat. Draw inspiration from the supplied references without copying their claims or assuming universal superiority.

Confirmed deliverable: an implementation plan for this repository, informed by the four `be-ambitious` questions. No implementation is authorized in this planning phase.

## Initial evidence

- Checkout: `codex/dream-rsi-2`; many existing modified and untracked files. Preserve all existing work. This document is the only new artifact from this planning session.
- `README.md` already describes assessment, unattended multi-lever orchestration, metric synthesis, calibration, bounded experiments, adversarial review, and recovery journals. Documentation is not proof that these paths work.
- `extensions/pi-dream-rsi/engine/loop.ts` already connects signal collection, lever selection, metric synthesis, campaigns, durable budgets, and experiment memory. Extend proven seams rather than design a replacement by default.
- `package.json` provides `npm run typecheck`, `npm test`, and a synthetic measurement benchmark. The no-emit typecheck passed during planning; tests and benchmarks were not run.
- The requested arXiv identifier is RSI-Master (`2609.35561`), a different paper from the README reference (`2609.14858`). Its inspected methods describe an Experiment OS and reviewer-guided exploration. The detailed Qwen quotation remains unverified.
- Concrete cold-start gap: `runLoop()` builds its inventory only from `collectSignals()`; the default path has no discovery-agent invocation. It rejects levers without recorded scope. `buildLeverInventory()` recognizes a fixed set of command labels and metrics (command duration, command failures, suite failures), rather than arbitrary project objectives.
- Concrete bootstrap gap: `synthesizeMetric()` requires an externally supplied known-better control patch; it does not generate one. `defaultSetup()` refuses an unready plan. Consequently a fresh repository with no useful logs, scope hints, or control patch does not meet the desired point-and-run behavior.
- Existing e2e tests exercise real orchestration with scripted edit/review agents, supplied session signals, and known control patches. Several Node fixtures check marker text rather than application semantics. These tests establish wiring, not general autonomous discovery or real-model improvement.
- Sources retrieved: autoresearch uses a protected evaluation boundary and a fixed five-minute training budget; Anthropic's relevant transferable mechanism is Memento's fresh-context restarts, not self-replication; MASS separates workflow search from weight distillation and reports uneven transfer to software-engineering benchmarks.

## Confirmed decisions

- Improve both target repositories and Dream-RSI's optimizer. Exclude model-weight training.
- Infer a project-specific outcome and confirm it once during setup; freeze the objective and constraints for the run.
- Use bounded local autonomy: after setup, discovery, metric qualification, experiments, local applies, and repetition run unattended. Releases, deployments, paid services, credentials, and destructive changes remain separately gated.
- User-selected execution scope: **trusted-local first**. Require explicit repository trust and host-execution approval at setup. Defer sandbox integration; do not claim containment or safe execution of unfamiliar repositories. No automatic infrastructure installation.

## Additional code findings

- `ucbSelect()` uses binary campaign win rate for tried levers, not measured objective gain or observed cost. Inventory expected-gain estimates are heuristics. Do not present this as identifying the globally biggest bottleneck.
- `checkCampaignEvaluator()` already hashes verifier assets, measures baseline variance, estimates detectability, and can test a control patch. Reuse this machinery. A control demonstrates sensitivity, not that the metric represents the user's goal.
- `promoteCandidates()` already rechecks paired measurements, gates, patch bytes, workspace drift, and adversarial review before journaled apply. Preserve this boundary.
- `agent/runner.ts` copies the parent environment except session identifiers and launches host processes. A copied workspace and post-run hash check are not an OS security boundary. Under the user-selected trusted-local scope, require explicit host-risk acceptance and narrower credential/environment exposure; defer actual containment.
- `scripts/setup-self-campaign.mjs` already creates content-addressed verifier snapshots and supports measurement, policy, controller, and prompt targets. Extend this self-target path rather than add a second self-modification mechanism.
- `eval/assess.mjs` explicitly grades lexical/structural properties, not semantic goal correctness. `eval/tier2.mjs` already supports real-model fixtures and independent post-campaign measurements with durable agent budgets. A new acceptance path must connect cold-start assessment to an actual semantic outcome without leaking fixture manifests.
- Planning baseline: `npm run typecheck` passed (exit 0, `tsc --noEmit`). Tests and campaigns were not run.
- Alibaba's official Apsara report supports a broad empirical-feedback RSI claim, but does not establish the quoted logs → synthetic data → small-validator → flagship-training procedure. Treat that specific sequence as inspiration, not a verified implementation or dependency.

## Expert standard: experimental software engineering

1. **Expert moves:** reproduce and profile a suspected bottleneck before optimizing it; distinguish metric validity from metric sensitivity; compare complete search procedures under equal budgets rather than celebrate one winning patch.
2. **Raw material:** target source, tests, manifests, runnable workloads, profiler output, per-experiment measurements and rejected patches; this checkout's implementation and tests; the primary-source methods listed below. Logs supplement discovery but are not required and do not define user value.
3. **Methods/tools:** bounded repository inspection; existing project profilers and test runners; frozen command-based evaluators; no-op, regression, and sensitivity controls; paired before/after measurements; differential or property-based correctness checks where an independent oracle exists; champion/challenger optimizer trials; fresh-context restarts and linked experiment records. Reuse Node's test runner, the current TypeScript checker, campaign verifier, and existing evaluation harnesses.
4. **External evidence:** the applied program must improve on independently run workloads while satisfying its frozen constraints. The optimizer must improve held-out outcomes across repositories at equal total resource limits. Invalid controls, changed tests, leaked answers, regressions, or budget overruns fail acceptance even if the search score rises.

## Reference decisions

| Primary source | Transferable idea | Limit / rejected inference |
|---|---|---|
| [RSI-Master, §2.2–2.3](https://arxiv.org/html/2609.35561v2) | Typed experimental actions, linked artifact provenance, evidence-based review and redirection. | Its model-post-training results do not demonstrate general repository optimization or universal absence of hacking. Reuse a ledger with parent links, not a second orchestration platform. |
| [autoresearch source](https://github.com/karpathy/autoresearch), including `program.md` | Small editable boundary, fixed evaluation, comparable experiment budgets, explicit keep/discard history. | Do not adopt permission disabling, indefinite spend, or destructive branch resets. Its fixed training task is not directly comparable to arbitrary repositories. |
| [Anthropic Memento, Appendix A](https://www.anthropic.com/research/self-replicating-ai) | Fresh agents inherit short factual notes to counter fixation. | No self-replication, device access, persistence installation, or autonomous resource acquisition. |
| [MASS methods and ablations](https://pub.sakana.ai/mass/) | Optimize information contracts and search strategy; evaluate optimizer progress separately; retain a champion against noisy regressions. | No weight distillation in this scope. Same-model judgments are not independent correctness evidence; reported software-engineering transfer is uneven. |
| [Alibaba's official Apsara report](https://www.alibabagroup.com/document-2041268239081668608) | Real feedback can motivate new experiments and regression cases. | The supplied detailed Qwen procedure remains unverified. Do not invent a training pipeline or claim that small-model agreement proves correctness. |

## Approach

Extend the existing pi extension and reusable engine. Do not create a standalone platform, distributed swarm, scheduler, or training system. The core remains stack-agnostic through explicit commands and artifacts; initial acceptance covers specified stacks, not every possible repository.

### 1. One approved run contract, then unattended work

Add a versioned `RunContract` owned by a new `engine/intake.ts`. It records canonical target identity, starting workspace fingerprint, project outcome, units/direction, useful gain threshold, preserved behavior and resource limits, allowed edit roots and protected assets, trusted-local execution consent, approved model/provider and data access, permitted command/resource categories, and durable total budgets. Have read-only recon propose this contract; approval can be interactive or an explicitly supplied headless contract. Approval of this plan does not approve a later paid model run.

Use one primary project utility with hard constraints; do not invent weights combining latency, correctness, and code size. Record why a secondary metric is a validated proxy. A lever outside the confirmed outcome needs a new contract, not an automatic objective change. With no defensible observable outcome, stop with the missing evidence.

Trusted-local is a risk acceptance, not containment. Separate agent authentication from evaluator environments; give probes, builds, gates, and generated programs only a declared environment allowlist. Exclude credential files, secrets, production configuration, and private session prose from copied contexts and artifacts. Inspect discovered script definitions before approving their execution category. Host repository code can still access the host or network: state that limitation prominently and require trust consent before any probe. No sandbox or network-isolation claims. Missing dependencies produce a setup blocker; do not install them automatically.

### 2. Cold-start discovery that reaches actual code

Add `engine/recon.ts` for bounded source/manifests/tests inspection and measured probes. Keep `collectSignals()` read-only and privacy-preserving. A new `prompts/lever-discovery.md` proposes schema-validated levers from cited code and observed workloads; the existing `discovery-agent.md` remains the candidate implementation prompt, not the assessor.

Prefer project-declared benchmark/test commands and installed profilers. Preserve exact argv, working directory, required fixtures, timeout, and environment rather than reconstructing execution from redacted command labels. An unfamiliar stack can use a validated generic command descriptor; do not add an adapter framework without evidence. Separate discovery from command execution; repository text is untrusted evidence, not authority.

Each proposal needs a causal mechanism, executable workload, verified file scope inside approved roots, baseline evidence, expected effect range or an explicit unknown, full verification cost, and a metric-validity argument. Reproduce reported failures and use measured bottleneck contribution where available. Log frequency, churn, and guessed percentages alone cannot establish priority. No-logs/no-history repositories must take this same source/probe path.

### 3. Autonomous metric qualification without a supplied solution

Extend `MetricPlan` into a frozen, content-addressed `EvaluationContract`: primary outcome and direction, dataset/workload identities, correctness oracle and protected gate assets (including their transitive local dependencies), search versus confirmation inputs, minimum useful gain, sample procedure, and calibration evidence. Generated evaluator authoring is a separate bounded role (`prompts/metric-author.md`), never part of candidate editing. Reuse a declared trustworthy evaluator before generating one.

Remove the *mandatory caller-supplied winning patch* requirement only through these qualification paths:

- When a valid known-better patch exists, keep the current control validation. Bind it to the exact baseline and evaluator identity; do not reuse it blindly after an apply.
- Otherwise, create a disposable, independently specified degradation or fault at the measured public seam. For runtime, introduce host-side extra work around the same real operation; for correctness, inject a known wrong result that an independent expected-output oracle must catch. Compare original against degraded/faulted states, plus an unchanged/no-op state. Controls never reach the target tree, candidate context, or search archive as candidate solutions.
- Test a plausible cheating shortcut (for example, skipping work or returning a constant) against the frozen correctness oracle. A constant scorer, wrong direction, missing workload, no-op sensitivity, or accepted shortcut invalidates the instrument.

A synthetic delay proves sensitivity only—not workload relevance or latent improvement headroom. Qualification also requires the workload-to-outcome argument and an independent correctness source (existing behavior contract, reference implementation, or independently specified invariants). Agent-written expected outputs and another model's agreement alone are insufficient. If that source or a suitable control cannot be established, reject the lever with an actionable reason. This is autonomous refusal, not successful optimization.

For correctness-repair goals, distinguish the failing behavior being optimized from preserved behavior. A reproducible known failure can be a scored outcome, not a gate that must already pass on the baseline. Freeze unaffected gates and the independently specified expected behavior; do not remove tests or accept new failures to make a repair measurable.

Freeze metric and oracle before candidate generation. Keep confirmation data outside candidate contexts and report only bounded feedback. In trusted-local mode, this prevents accidental disclosure, not hostile filesystem access. Any evaluator revision creates a new identity, fresh baseline and controls, and non-comparable history; a plateau is not permission to lower standards or switch to an unrelated objective.

### 4. Cost-aware hill climbing across mechanisms

Keep `runLoop()` as the outer controller and `runCampaign()` as the experiment engine. Use hill climbing within a mechanism, and bounded exploration across mechanisms. Extend `ucbSelect()` to rank expected **project-utility gain per total verification cost**, with an exploration allowance and explicit uncertainty; retain current selection as a benchmark baseline. Do not pretend the current heuristic estimates are calibrated probabilities. When evidence is sparse, use measured probes and explicit unknowns rather than fabricated precision.

Extend ledger/memory with baseline, objective, evaluator and optimizer fingerprints, parent experiment, mechanism, observed gain, measured cost, and rejection reason. Reuse bounded JSONL events and atomic state; no graph database. Keep losing evidence and distinct promising mechanisms, not only the most recent patch. Deduplicate mechanisms and patches within their baseline identity. Revalidate stale proposals after every apply; old scores are not comparable on a changed target.

Pass short factual memory into new assessor/candidate contexts. A plateau triggers a bounded review of evidence and a different mechanism or probe, not merely a different metric. Every accepted patch still passes fresh paired confirmation, frozen gates, scope/drift checks, adversarial review, and journaled apply. Before the next unattended iteration, independently run the primary outcome/semantic check on the resulting state; do not infer success only from an apply ledger entry. On failure, stop and retain recovery evidence; restore only transaction-owned bytes when preimages still match, never overwrite intervening user edits.

### 5. Account for the whole autonomous run

Move loop process reservations behind a small `LoopBudget` in `engine/loop-budget.ts`, reusing `CampaignBudget` and ownership/atomic-write patterns. Discovery, profiling, evaluator authoring, controls, candidate runs, review, independent post-apply checks, and optimizer evaluation all consume the same durable parent allowance. Reserve child grants before dispatch; reconcile observed starts and conservatively charge unknown spend after crashes. No free retries or reset-on-resume. Reserve enough for confirmation and recovery before starting a candidate.

Maintain immutable cumulative campaign/agent/evaluator ceilings and a durable total wall-time allowance across restarts, with a monotonic in-process deadline. Record token/cost telemetry when available; do not advertise a hard dollar/token ceiling unless the configured provider can enforce a per-call bound. Resolve the approved active session model at each call; a provider outside the approved contract needs new permission. Start with the current one-agent configuration; cheaper model routing is not a new subsystem.

For noisy promotions, predeclare a configurable loop-level false-accept budget (default 1%) and conservatively allocate it over the finite maximum confirmations/campaigns and interim looks. Extend the existing measurement plan instead of writing a second statistical engine. Keep practical effect size distinct from statistical detectability. Inconclusive or unaffordable evidence means no promotion. Report assumptions about drift, tails, dependence, and empirical error bounds; a finite synthetic suite is not a universal statistical guarantee.

Stop/status/resume must address discovery, authoring and post-apply work as well as campaigns, including between-campaign windows. Integrity failures stop the run; ordinary unready levers can be rejected and another screened. Preserve budget/deadline/cancelled/blocked/plateau/no-verifiable-lever reasons and explain missing dependencies, permissions, or evidence.

### 6. Improve the optimizer without letting it certify itself

Extend `setupSelfCampaign()` and the existing protected self-evaluator path to cover discovery, selection, and prompts. Mine only bounded consented aggregate failures; convert reproducible failures into development regression cases, not fresh held-out evidence. Keep a versioned champion optimizer, and propose a challenger in a separate snapshot. The running generation never modifies its own verifier, approval policy, budget enforcement, or recovery boundary.

At setup, reserve a bounded optimizer-trial sub-budget within the total allowance. On a plateau or repeated attributable structural failure, permit at most one challenger trial per generation, only if confirmation fits in that reservation. Insufficient evidence or budget retains the champion and produces an honest stop. The top-level session can continue the same approved project with a promoted generation through a fresh child run; it cannot renew budgets or permissions. This connects self-improvement to the unattended loop without making every project iteration pay for a meta-experiment.

Score challengers on externally defined semantic outcomes, all-in cost, false applies, and regressions across development repositories. Confirmation uses a sealed repository-level split and matched models/resources. The evaluator and champion snapshot are outside candidate scope. A challenger must pass fixed safety/correctness constraints and show a strictly positive independently measured improvement over the champion; otherwise retain the champion. Freeze and charge confirmation attempts and retire an exposed holdout; do not repeatedly tune against the same acceptance feedback.

Apply accepted optimizer changes locally as a new immutable generation. Verify one independent result before activation; activate only between runs through a fresh process/module load, with the old generation retained for rollback. No hot mutation of the running controller, automatic publication, or model-weight training. Report repository optimization and optimizer improvement separately.

## Files to modify

Paths below are the intended implementation boundary, not permission to overwrite current user work. Re-read diffs before each slice; work around existing edits and stop only if they conflict.

| Paths | Change |
|---|---|
| New `extensions/pi-dream-rsi/engine/intake.ts`, `recon.ts`, `loop-budget.ts` | Run contract; bounded discovery/probe results; all-phase durable accounting. Separate these responsibilities from the already large campaign module. |
| `engine/loop.ts`, `levers.ts`, `search.ts`, `signals.ts`, `ledger.ts` under `extensions/pi-dream-rsi/` | Wire discovery, utility/cost allocation, provenance, baseline invalidation, short memory, phase-wide cancellation and honest coverage. Preserve signal privacy. |
| `engine/metrics.ts`, `measure.ts`, `campaign.ts`, `campaign-patch.ts` under the same root | Frozen evaluation contracts, calibration paths, global statistical allowance, independent semantic confirmation and existing transaction safeguards. Limit campaign edits to these integration seams. |
| `extensions/pi-dream-rsi/agent/runner.ts`, `engine/task.ts` | Role-specific execution/command descriptors, declared environment, bounded output and reservations. Preserve existing public task compatibility. |
| `extensions/pi-dream-rsi/index.ts`, `dashboard.ts` | Contract approval/headless contract input; all-phase status, stop/resume and spend. Keep `/dream-rsi loop` and targeted improve entry points. |
| New `prompts/lever-discovery.md`, `prompts/metric-author.md`; existing candidate/review prompts | Distinct role contracts and prohibited metric gaming; independent review with evidence. |
| `scripts/setup-self-campaign.mjs`, `scripts/self-improve.mjs`, `eval/self-controller.mjs`, `eval/controller.mjs`, `eval/assess.mjs`, `eval/tier2.mjs`, `eval/fixtures/` | Protected optimizer targets and semantic, no-oracle cold-start evaluation. Reuse fixture loading and budget accounting. |
| Existing `tests/loop*.test.mjs`, `levers.test.mjs`, `metrics.test.mjs`, `search.test.mjs`, `measure.test.mjs`, `extension.test.mjs`, `agent-runner.test.mjs`, `self-*.test.mjs`; new focused intake/recon/budget tests | Contract and regression coverage at public seams; retain existing scenarios rather than duplicate them. |
| `README.md`, `docs/self-improvement.md`, new `docs/autonomous-loop.md`, relevant `skills/dream-rsi*/SKILL.md`, `CHANGELOG.md`; `package.json` only if shipped harness files change | Document setup/trust, measured support, metric qualification, control failures, budgets, recovery and evidence limits. No new npm runtime dependency is planned. |

Version persisted contracts explicitly. Existing campaign records retain their frozen meanings; old loop state without objective/trust fields cannot silently resume under new semantics. Report the missing contract and require a newly approved run. Preserve old budgets/history and keep any migration additive and recoverable; do not delete or reset state to enable more spend. Reuse `evaluators/measure.mjs` for elapsed/numeric measurement where its platform behavior fits; do not rewrite unrelated adapters or legacy policy code.

## Reuse

- `runCampaign()`, `checkCampaignEvaluator()`, `promoteCandidates()` in `engine/campaign.ts`: baseline/control checks, review and promotion integration.
- `verifyCandidatePatch()`, `runCampaignGate()`, `applyCandidatePatch()`, `reconcileCandidatePatch()`, `workspaceDigest()` in `engine/campaign-patch.ts`: measurement, integrity, transactional apply and recovery.
- `planTest()` / `runPaired()` in `engine/measure.ts`: measurement decisions and paired execution.
- `collectSignals()` in `engine/signals.ts`: bounded optional log/Git/evaluator facts; do not widen transcript collection.
- `CampaignBudget` in `engine/campaign-budget.ts`, ownership utilities and `writeFileAtomic()` in `engine/world.ts`: durable reserve-before-start mechanics.
- `ucbSelect()`, `mementoNotes()`, `readMemory()` in `engine/search.ts`; ledger sanitization in `engine/ledger.ts`: extend these, not competing memory stores.
- `setupSelfCampaign()` in `scripts/setup-self-campaign.mjs`: verifier snapshots and existing self-target setup.
- Fixture loading, `reserveAgentBudget()`, and independent outcome measurement in `eval/tier2.mjs`; structural assessment in `eval/assess.mjs`: extend to semantic end-to-end evidence.

## Steps

Planning completed: repository/working-state inspection, source-method inspection, concrete gap analysis, user scope decisions, and no-emit typecheck. Implementation is pending review.

- [x] **Baseline and failing acceptance seam:** preserve current user work; run the safe existing suite in its normal temporary fixtures, record pre-existing failures, and add a cold-start semantic test before new engine code. It supplies no logs, scope hints, evaluator, control patch, or solution manifest to the loop.
- [x] **Run contract and durable phase accounting:** implement intake, trust approval, fingerprints, environment policy and whole-run reservations first. Add stop/resume/crash tests before wiring agent work.
- [x] **Cold-start discovery:** add bounded code inspection, declared command discovery and measured probes; feed validated proposals through existing levers/search. Prove a planted causal bottleneck is reached and irrelevant high-frequency signals are rejected.
- [x] **Metric authoring and qualification:** implement frozen outcome/oracle contracts, independently specified controls, no-op/shortcut rejection and budget-fit checks; remove the manual-control prerequisite only for qualified paths. Keep existing supplied-control campaigns working.
- [x] **Closed loop:** connect cost-aware selection, experiment provenance, baseline invalidation, fresh-context redirection, global confirmation allowance and independent post-apply checks. Demonstrate at least two successive real improvements and a moved bottleneck without changing objectives.
- [x] **Optimizer generations:** extend protected self-targets; compare champion/challenger on development and sealed confirmation repositories; test accept/reject and fresh-process activation/rollback with a scripted challenger before any paid trial.
- [x] **Public surface and durable docs:** wire existing commands/dashboard/skills and state-version handling. Review material trust-boundary changes before production; no release actions in this plan.
- [x] **Verification and comparison:** run the checks below, inspect final intended diffs/new files, then conduct a fresh read-only independent review using `gpt-6.1-sol` at high reasoning if available. Address findings and rerun affected checks. If unavailable, report that gap rather than silently replace the reviewer.

## Verification

### Repeatable local checks

Run `npm run typecheck` and `npm test` after stable implementation slices. Run affected Node test files first. Full-suite baseline/final results must include failures and skipped toolchains. Reuse `node eval/bench.mjs --seeds 20000` and `--held-out --seeds 5000` for measurement regressions, and extend the benchmark for the loop-level allowance, multiple looks/campaigns, drift and discrete-noise controls. These commands are for implementation, not already-run evidence.

Extend the existing `eval/tier2.mjs` and assessment harness with an explicit cold-start loop mode; its production path is `/dream-rsi loop` → approved contract → discovery → metric qualification → campaigns → independent post-apply outcome → next lever. Use the same engine and public schema as the tool, not `taskProvider`/signal stubs to claim discovery. The harness must remain inert without explicit `--run`, model and cumulative budgets. Freeze workload sets and thresholds before a comparative run.

### Required behavioral evidence

| Scenario | Pass criterion |
|---|---|
| Cold start | Node, Python and one installed compiled-language fixture reach causal source scopes without logs or supplied winning patches; independent executable behavior, not marker removal, determines success. Include a custom command and nested/monorepo path. Missing toolchains are reported as gaps, not passes. |
| Metric validity | Unchanged/no-op controls do not win; positive sensitivity and known fault controls are detected; wrong direction, constant scores, skipped work, empty test selection and absent oracle are rejected. Original target and protected assets remain unchanged by calibration. |
| Continued autonomy | At least two sequential verified improvements occur in the multi-bottleneck fixture; every next step uses a fresh baseline. A stale control patch, stale score or old scope cannot establish a new win. |
| Negative/adversarial cases | Zero false applies in the fixed test corpus: no headroom, no-op edits, test weakening, fabricated score, out-of-scope edit, hidden regression and review rejection. Report corpus size and confidence bounds; zero observations is not proof of zero real-world risk. |
| Failure/recovery | Interrupt each phase, exhaust budgets during controls/confirmation, corrupt state, race stop/status and mutate the target during verification/apply. No unreserved process, duplicated apply or overwritten user edit; evidence and recovery preimages remain available. |
| Trust/privacy | No command before trusted-local approval; undeclared environment keys and secret files stay out of evaluator contexts/artifacts; denied command categories cannot be authorized by repository text. Demonstrate the limits of host mode—do not label these tests sandbox assurance. |
| Optimizer recursion | A scripted genuinely better challenger is promoted, a gaming/regressing/no-op challenger is not, and a fresh generation activates only after independent checks. The evaluator, approval policy and resource limits remain fixed. |

### Real-model and superiority claims

Real-model trials are separately authorized, budgeted acceptance work. Do not run them during planning or assume plan approval authorizes service spending. First validate one real trial against independent semantic outcomes, then keep that check in every trial. Use repository-level development/confirmation separation, varied seeds and blinded outcome checks; retire confirmation sets after feedback is used.

Compare (a) the current controller, (b) a simple equal-budget keep/discard hill climber, and (c) the proposed controller using the same model, approved environments and **all-in** budgets including discovery and metric authoring. Use cold-start comparisons for autonomy and a separate shared-qualified-evaluator comparison for search quality; otherwise a zero-start baseline confounds discovery with optimization. Do not claim direct superiority to MASS/RSI-Master/autoresearch on their unrelated training tasks.

Primary comparison: independently confirmed project utility gain at fixed total resources; secondary diagnostics: time/cost to first real win, validated discovery rate, qualifying-metric rate, cumulative gain, regressions, false applies and stop reasons. Normalize only with benchmark-owner-fixed scales; report per-repository raw outcomes as well. A superiority claim requires the lower bound of a predeclared paired 95% confidence interval for aggregate utility advantage to exceed zero against the strongest applicable baseline, with no safety-contract failure and no predeclared hard-constraint regression. If budget yields inconclusive evidence, report inconclusive—do not expand spend or loosen criteria. Synthetic/scripted tests alone cannot certify real-model optimizer improvement.

## Limits and done criteria

Done means cold-start trusted-local operation works on the declared support matrix; metric qualification does not require an input solution; repeated applies improve independently observed outcomes; optimizer improvement is measured separately through protected generation promotion; whole-run permissions, spend and recovery are enforced; and results honestly distinguish passed local contracts from unrun real-model/generalization checks.

Not promised: every repository has a measurable improvement, global bottleneck optimality, indefinite guaranteed progress, safe execution of hostile repositories, model-weight improvement, deployment, or being better than every referenced system. Unsupported/no-oracle cases must stop usefully.

Planning checks: `npm run typecheck` passed; `git diff --check` reported no whitespace errors (existing LF/CRLF warnings only). Reviewed this plan and verified the named reuse exports. No tests, benchmarks, campaigns, installs, commits, or code edits were performed.

Confidence: 88% in the implementation plan, based on current-code tracing, primary-source methods, and resolved scope decisions. Autonomous improvement rates and cross-project generalization remain unverified until the planned experiments run.
