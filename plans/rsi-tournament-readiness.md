# External tournament readiness

Status on 2026-10-18: **not preregistered and not run**. This file records the blockers; it is not a preregistration, result, or pass claim.

## Required protocol

The requested comparison has seven arms: current Dream-RSI 2.0, an RSI-Master-style Experiment OS, MASS-style workflow search and trajectory distillation, an autoresearch-style fixed-budget loop, a Qwen-telemetry funnel, an AIDE/Claude-Code-style agent, and profile-guided non-LLM tuning. All arms need the same pinned starting revision, outcome, time and evaluator budgets per repository, independent correctness oracles, and fresh-process reproduction. Candidate selection and policy tuning must use a development population disjoint from the sealed tournament repositories.

The result set must include at least five previously unseen repositories across at least three languages, a sealed correctness and performance suite owned by an independent evaluator, source and environment hashes, per-repository budget reservations, all attempt and evaluator costs, loss cases, the cost/hit-rate curve, and exact reproduction commands for each arm and result. Record the cost/hit-rate curve at 25%, 50%, 75%, and 100% of each fixed budget, and pin the numeric tolerance for fresh-process reproduction. The preregistration reserves wall time, evaluator runs, and cost for the external judge inside each repository budget; the sandbox receives only the remainder. Register the repository as the statistical unit, compare paired per-repository outcomes, report paired 95% confidence intervals with the method and multiplicity correction fixed before runs, and publish all exclusions. Define Pareto dominance before the run: Dream-RSI must be no worse than each arm on every preregistered outcome and strictly better on at least one, with paired uncertainty reported. Define an unverifiable apply as any accepted patch whose exact artifact, evaluator evidence, provenance, and fresh-process reproduction cannot be independently checked. Define a hidden regression as any significant correctness-oracle failure or preregistered performance regression on a held-out suite. Canaries must be identified in the evaluator commitment and generated from committed seeds withheld from candidate agents. A pass additionally requires the user's stated 60% hit-rate, zero unverifiable applies, zero hidden-suite regressions, 100% seeded-canary detection, fresh-process reproduction, rising sealed-population generation score, per-mechanism ablations, and each reference's home benchmark.

## Missing prerequisites

- Tournament preregistration and signed-results validators now check protocol shape, evidence completeness, and external signatures against separately supplied registry/evaluator keys. There is still no sealed repository manifest, hidden-oracle inventory, independent judge endpoint, canary seed registry, or real signed results report in this checkout.
- No seven pinned, runnable arm implementations or their per-arm home-benchmark adapters are present.
- The test evaluation uses local scripts and scripted agents. Its scenarios and evaluators are visible in this repository and do not qualify as external hidden oracles.
- The optional Microsoft MXC process-container backend is available and canary-tested on this Windows 11 24H2 build (26100.9711). `LoopOptions.containment` routes recon, qualification, baseline, campaign evaluator, candidate confirmation, gate, and post-apply commands through disposable copies. Campaign probe, live, policy-development, and reviewer agents also use disposable workspaces and managed process handles. The dream-phase agent can write only a temporary `method.ts`; campaign state, histories, traces, and policy APIs mount read-only. Windows managed stdio requires Node 24.21. I verified a portable Node 24.21 archive, but Node subprocesses still exit with `STATUS_DLL_INIT_FAILED` in this host session. Agent containment preflight now runs `node.exe --version` and refuses before recon with the session diagnosis. MXC's [upstream issue #1465](https://github.com/microsoft/mxc/issues/1465) documents the same failure for USER32-dependent workloads in non-interactive BaseContainer sessions. A remote-model broker is not configured, so no-egress agent processes cannot reach a remote model provider. Containment remains opt-in and no full-loop no-exfiltration claim is established.
- The current generation evaluator is a local replay/controller harness, not an external judge over a sealed population of unseen repositories. The local Qwen-inspired miner reads structural session telemetry and makes synthetic scenarios; it does not reproduce a verified Qwen training funnel.
- Running the reference home benchmarks requires source-specific datasets, models, hardware, and benchmark environments not present or pinned by this repository.

These are execution and trust-boundary blockers, not evidence that an arm lost. Assigning repository names, hidden-test hashes, judges, arm versions, or measured results without those artifacts would turn the requested preregistration into a fabricated one. Do not label this tournament registered, externally validated, or passed until those prerequisites are assembled and pinned.

## Preregistration validator

`eval/tournament/preregistration.mjs` rejects incomplete protocols and validates the Ed25519 receipt over the canonical manifest digest, registration URL, and timestamp. It requires seven pinned arms, five withheld repositories across three languages, shared per-repository budgets, a disjoint policy-development population, an independent evaluator's hidden-suite and canary commitments with explicit canary IDs, paired 95% confidence intervals with Holm correction and a preregistered one-sided Dream-advantage alternative, fixed outcome directions/checkpoints/reproduction tolerance, argv arrays rather than shell command strings with content digests for arm commands, all nine performance ablations, all five source home-benchmark entries mapped to pinned arms, and reporting commitments for loss cases, the cost/hit-rate curve, and exact reproduction commands. The caller must supply the registry public key through a separate file. The validator does not submit to a registry or prove that the supplied key belongs to a trustworthy registrar.

```powershell
node --test tests/tournament-prereg.test.mjs
npm run tournament:prereg -- .\path\to\manifest.json .\path\to\trusted-registry-public-key.pem
```

Results: the validator tests passed 6/6. The focused test run validates a complete synthetic signed manifest and rejects missing external trust, tampering, incomplete splits, malformed shapes, duplicate canaries, changed budget checkpoints, negative reproduction tolerance, and unpinned home-benchmark arms. The CLI rejects an incomplete draft and enumerates its missing requirements. Tests use generated keys and synthetic manifests; no preregistration or external trust anchor exists for the real tournament.

### Signed result audit

`eval/tournament/results.mjs` validates an evaluator-signed report against the externally verified preregistration and a separately supplied evaluator key. It requires every repository × arm × budget-checkpoint cell, validates cumulative cost/time/agent/evaluator budgets at each checkpoint, binds exact argv vectors and home-benchmark baselines to preregistration, and requires the apply artifact, ledger head, evaluator evidence, and fresh-process reproduction to agree for every Dream-RSI win. It computes paired repository bootstrap intervals with Holm step-down correction for each arm/outcome, requires every mechanism ablation to show a Holm-supported drop, and emits the cost/hit-rate curve, measured loss cases, and reproduction commands. Malformed or unsigned evidence returns diagnostics and cannot pass.

```powershell
node --test tests/tournament-prereg.test.mjs tests/tournament-results.test.mjs
npm run tournament:results -- .\path\to\manifest.json .\path\to\signed-results.json .\path\to\trusted-registry-public-key.pem .\path\to\trusted-evaluator-public-key.pem
```

The focused synthetic suite passes 10/10 tests. Its generated Ed25519 keys, repository data, benchmark scores, and signed results validate the gate implementation only. The out-of-band keys are not real trust anchors, the CLI has no real signed input to audit, and this does not constitute a registered or externally run tournament. The evaluator's signature is the trust boundary: the local verifier cannot prove that an external signer actually ran its committed hidden suite.

### Registered tournament runner protocol

`eval/tournament/runner.mjs` now controls the protocol after registration. It verifies the signed preregistration, the sandbox adapter bundle digest and evaluator build digest, and the exact runtime repository set before launching anything. Its deterministic hash-based schedule varies repository and arm order. For each repository/arm pair it invokes one sandboxed run that emits cumulative receipts at 25%, 50%, 75%, and 100% of the same preregistered budget. Each receipt binds the source revision, environment, arm command and implementation digests, immutable candidate artifact, ledger head, and usage. The preregistration reserves judge wall time, evaluator runs, and cost at every checkpoint; the sandbox gets only the remaining allowance. The controller sends candidate artifacts to a separate pinned evaluator process; no judge response is sent to the arm. The evaluator signs the assembled report, which the controller audits before saving as a result file.

The sandbox adapter contract requires a denied-egress contained environment, a fresh copy of the pinned repository for each arm, candidate-only writable paths, cumulative budget enforcement, and immutable checkpoint artifacts. The external evaluator adapter must keep hidden suites and canary seeds out of the arm process, independently score each exact artifact, account for its pre-reserved resources, and sign the final report. Both adapters are operator-provided and content-pinned in the preregistration. This controller cannot establish that a third-party adapter actually enforced its declared isolation or ran the hidden suite.

```powershell
node --test tests/tournament-runner.test.mjs tests/tournament-prereg.test.mjs tests/tournament-results.test.mjs
npm run tournament:run -- .\registered-preregistration.json .\runtime.json .\trusted-registry-public-key.pem .\trusted-evaluator-public-key.pem
```

Results: the protocol/preregistration/result-gate tests passed 16/16. The runtime validator tests use local temporary bundles and fake receipts; no real adapter, registration key, repository set, or hidden evaluator is configured, and the runner has not executed an external tournament.

### Bounded workflow search and sealed trajectory priors

The local policy layer now defines a versioned workflow graph with allowlisted scout, implementer, reviewer, and verifier roles; fixed instruction and evidence-contract vocabularies; a single-root acyclic graph; and a six-stage cap. Candidate generation changes one role, instruction, contract, or hop at a time and rejects malformed structures. Signed workflow evidence is checked against host-pinned evaluator keys, one consistent development corpus, five distinct repositories, and an explicit withheld population before winning profiles and bounded neighbors are added to the editable research-org policy. This policy remains a hypothesis; candidate activation still requires the independent hidden-split receipt.

```powershell
npm run typecheck
node --test tests/research-policy.test.mjs
```

Results: typecheck passed and focused workflow/policy tests passed 7/7. These tests use ephemeral signing keys and synthetic trajectories. Workflow evidence is wired into the existing sealed policy-candidate path, but the campaign runner retains its current phase schedule and there is no production corpus, trusted judge, or tournament runner. This is local mechanism coverage only, not evidence that workflow search improves unseen repositories.

### Qualification regression follow-up

The first full `npm test` run exposed that qualification treated every surviving comparison/numeric/boolean mutant as a veto. This incorrectly rejected score and duration tasks when a mutant changed a runtime-only detail while preserving the correctness contract. Mutation outcomes now remain visible in the qualification report but are advisory; the instrument's measurement, declared correctness gates, budget fit, and independent post-apply confirmation stay blocking. I also fixed the loop's terminal diagnosis so it reports `budget` when recon and qualification exhaust the allowance before a campaign can start.

Focused verification after the fixes:

```powershell
npm run typecheck
node --test tests/research-policy.test.mjs
node --test --test-name-pattern="an instrument is qualified without any supplied winning patch" tests/metric-qualification.test.mjs
node --test --test-name-pattern="contract-declared score evaluator proves an accuracy win independently" tests/cold-start.test.mjs
node --test --test-name-pattern="a loop that plateaus retains the champion when no sealed harness is configured|a loop promotes a scripted challenger only after its evidence passes" tests/generation.test.mjs
node --test --test-name-pattern="qualification spend cannot push a campaign past the durable evaluator cap" tests/run-contract.test.mjs
git diff --check
```

These targeted checks passed after the fix. A later full `npm test` run also passed with 470 tests passing, zero failures, and five held-out cases skipped behind explicit environment gates. No benchmark result from these local fixtures is an external tournament result.

## Local commands actually run

```powershell
npm run typecheck
node --test tests/cold-start.test.mjs tests/metric-qualification.test.mjs tests/run-contract.test.mjs
npm test
```

The current full suite before the ledger-head checkpoint follow-up exited 0 with 475 tests, 470 passed, 5 skipped behind explicit environment gates, and 0 failed. Earlier runs listed in `.audit/rsi-full-suite.log` are historical and superseded by this run. These commands do not meet the tournament requirements.

## Latest optimizer-admission verification

After adding signed evaluator receipts, these current-tree checks passed:

```powershell
npm run typecheck
node --test tests/generation.test.mjs
$env:DREAM_RSI_LOOP_E2E_REPEATS='1'; node --test --test-name-pattern='loop wins on fresh clones of the pytest fixture' tests/loop-e2e.test.mjs
```

Results: typecheck passed; generation tests passed 9/9, including persisted-artifact allowlist and digest checks; the isolated Python/pytest loop fixture passed 1/1 in 74.5 seconds (69.7 seconds measured loop wall time). A concurrent full `npm test` run observed 435 tests, 430 passed, 2 failed, and 3 skipped. One failure was the generation assertion using its pre-receipt error text; the assertion was updated and the focused generation suite then passed. The other was the pytest fixture exceeding its 600-second campaign deadline under the full suite's heavy parallel subprocess load; the isolated rerun passed. The full suite was not rerun serially, so this record is not a full-suite pass. After that verification, active-generation content was wired into fresh campaign initialization; focused local behavior tests for method materialization and both prompt overrides are recorded below. None of these local checks use an external hidden evaluator or establish tournament outcomes.

### Active-generation runtime verification

The campaign now validates the loaded generation manifest and every artifact digest before creating a campaign, stores an immutable campaign-local copy, seeds the isolated method from that copy, and reads prompt overrides from the copy on fresh execution and resume. Focused local checks exercised method materialization, discovery-prompt delivery, policy-improvement-prompt delivery, and TypeScript correctness:

```powershell
node --test --test-name-pattern="generation-pinned discovery prompt|two full iterations" tests/live-dream.test.mjs
node --test --test-name-pattern="verified optimizer generation" tests/campaign-runtime.test.mjs
npm run typecheck
git diff --check
```

Results: the generation suite passed 9/9, including a separately rooted next loop loading the promoted generation and forwarding its verified file content to a campaign. Three selected runtime cases passed across the live/dream and campaign test processes, covering method materialization and both prompt overrides. Typecheck and diff checks passed. These fixtures use scripted local agents and local evaluators; they prove artifact wiring only, not independently judged policy improvement or safe execution of untrusted repositories.

### Trajectory-distilled policy candidate

At a plateau, the loop now proposes a single-artifact `prompts/research-org.md` candidate when its history contains positive, independently verified wins. The distiller groups only by the hashed contract/evaluator domain and a closed lever-source class; it does not copy free-form repository text into the prompt. The confirmation adapter receives the candidate's files and temporary artifact root, must register that exact content, and must return a signed receipt. The loop rejects a different id, a missing staged challenger, or a changed artifact digest before applying the receipt. This is a candidate producer, not the requested sealed-population policy loop: it currently distills only the current loop's memory, and no production independent confirmation service is configured.

Verification commands:

```powershell
npm run typecheck
node --test tests/research-policy.test.mjs
node --test tests/generation.test.mjs
node --test --test-name-pattern="verified optimizer generation" tests/campaign-runtime.test.mjs
node --test --test-name-pattern="generation-pinned discovery prompt|two full iterations" tests/live-dream.test.mjs
git diff --check
```

Results: typecheck passed; research-policy tests passed 3/3; generation tests passed 9/9; the selected campaign-runtime case passed 1/1; selected live/dream cases passed 2/2. These checks use scripted fixtures and do not establish sealed cross-repository gains, independent production judging, or containment.

### Signed sealed-population policy evidence

Policy candidates can now use host-supplied Ed25519-signed aggregate trajectory evidence instead of current-loop memory. The schema pins corpus and development-population digests, evaluator identity, repository digest, contract domain, lever class, trial/win counts, and an evidence digest. Distillation requires host-pinned evaluator keys, at least five distinct development repositories, one consistent corpus/population, and an explicit withheld repository set; overlap with the withheld set, duplicate records, bad signatures, and unknown evaluators fail closed. The local-memory distiller remains the fallback when no sealed corpus is configured. No real signed corpus, key custody, withheld repository inventory, or independent feed is configured in this checkout, so this is an ingestion and validation seam, not evidence of cross-repository policy improvement.

```powershell
npm run typecheck
node --test tests/research-policy.test.mjs
node --test --test-name-pattern="loop promotes a scripted challenger" tests/generation.test.mjs
```

Results: typecheck passed; focused policy tests passed 5/5; the promotion integration passed 1/1 and confirmed that the signed sealed-population policy, rather than local loop history, is staged, promoted, and loaded by a separately rooted next-process fixture. The signature fixtures use ephemeral local keys and do not establish an externally governed corpus.

### Windows process-container canary verification

The host's native probe reports the Microsoft ProcessContainer backend at the `base-container` isolation tier. `LoopOptions.containment` routes recon, qualification, baseline, campaign scoring, candidate confirmation, correctness gates, and post-apply measurement through the adapter. Campaign probe, live, policy-development, and review agents also receive disposable writable roots; managed launches use process handles for stdin, output, PID ownership, timeout, and abort cleanup. The loop checks full agent-process support before recon and refuses if unavailable. Containment remains opt-in. See “Expanded process containment” below for current host-version results and limitations.

```powershell
npm run typecheck
node --test tests/sandbox-containment.test.mjs
```

Results from this initial check: the shell/workspace and host-access canaries passed. The managed agent-process path and full tournament were not verified in this initial check; the later expanded-containment section records the updated results.

### Campaign resource-ledger verification

Agent-start reservations are individual append-only ledger events, and paired confirmation events account for both before/after evaluator runs. The process runner now records one result event after output decoding for probe, discovery, review, and policy-development agents, including elapsed time and decoded token usage. A successful accepted-candidate campaign checks that ledger reservations equal the durable process counter and that probe/discovery/review evidence and evaluator time are present. Resource totals remain partial: there is no provider-price or machine-energy schedule, and unrelated host-side helper work is not metered.

```powershell
node --test tests/ledger.test.mjs
node --test --test-name-pattern="accepted review applies the measured patch" tests/campaign-runtime.test.mjs
npm run typecheck
git diff --check
```

Results: ledger tests passed 9/9; accepted-candidate campaign passed 1/1; typecheck and diff check passed. This verifies accounting wiring in local fixtures; it does not provide tournament cost totals or a cost/hit-rate curve.

### Seeded-canary receipt binding

Version 2 promotion receipts no longer rely on aggregate `seeded/detected` counts. Each public canary id is deterministically derived from its seed commitment. The host pins a SHA-256 digest over the complete manifest; the signed receipt must include each canary id, matching commitment, and a boolean detection result. Replaced commitments or a receipt from another manifest fail before consuming the one-use confirmation attempt. The seed material itself is not included in the receipt.

```powershell
npm run typecheck
node --test tests/generation.test.mjs
```

Results: typecheck passed; generation tests passed 10/10, including missed-canary rejection and substituted-manifest rejection. The fixture uses test-only ephemeral keys and manifest entries. No production canary registry, hidden seed service, or independent detection run is configured.

### Admission mutation-oracle verification

For qualification paths without a supplied winning patch, the admission OS now selects up to two comparison, numeric, or boolean tokens in editable source files, mutates them one at a time in disposable copies, and requires a declared correctness gate to reject every mutant. Unsupported scopes or surviving mutants refuse qualification with a diagnostic. Each trial uses the existing evaluator reservation callback, so it consumes the declared process budget.

```powershell
npm run typecheck
node --test tests/metric-qualification.test.mjs
git diff --check
```

Results: typecheck passed; metric qualification tests passed 13/13, including two killed mutants in the real Node fixture and the constant-score source fallback. This remains a bounded sample, not broad mutation coverage; no property-based or differential oracle generator is implemented.

### Qualification budget preflight

Before qualification starts an evaluator, it now estimates its maximum declared process count from baseline passes, the sensitivity control, the missing-workload control, pristine/inert gate checks, and each selected mutant against each gate. It adds a worst-case noisy promotion floor and compares the result with the lesser of the contract cap and the loop's live remaining evaluator allowance. If that cannot fit, it returns one `budget-fit` diagnosis and starts zero evaluator processes. After qualification, the confirmation check compares both deadline and remaining process allowance. This is a run-count bound; it does not predict wall time for each process or meter untrusted host-side helper work.

Verification: `npm run typecheck` passed; `node --test tests/metric-qualification.test.mjs` passed 14/14 in 74.4 s; `node --test tests/loop.test.mjs` passed 29/29 in 45.9 s. The undersized-allowance case asserts a preflight refusal and zero evaluator starts. No external tournament claim follows from these local fixtures.

### Expanded process containment

Recon now copies the project into a disposable workspace before probing. Metric qualification copies its evaluator into each disposable workspace when the evaluator lives outside the project copy, then runs both evaluator and correctness-gate commands inside the OS container. Campaign agent calls for probe, live attempts, policy development, and candidate review now receive one writable workspace root. The managed MXC path passes prompts through stdin, streams output, reports the owned PID, and kills/reaps the process on abort. Tool directories from `PATH` are automatically made read-only; operators can add roots for toolchains not on PATH.

Verification on Windows 11 24H2 build 26100.9711:

```powershell
npm run typecheck
node --test tests/sandbox-containment.test.mjs
node --test tests/recon.test.mjs
node --test --test-name-pattern="metric qualification runs its evaluator" tests/metric-qualification.test.mjs
node --test --test-name-pattern="two full iterations" tests/live-dream.test.mjs
```

The initial check on the system Node 24.14 skipped managed stdio. I then downloaded the official portable Node 24.21 Windows archive and verified SHA-256 `158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541`. Under that runtime, the managed process lifecycle canary passed, but the Node workload required by repository evaluators exited with `STATUS_DLL_INIT_FAILED` (`-1073741502`). The suite now includes that workload-start check in agent-containment preflight. With it enabled, the sandbox suite passes 4 checks and skips the managed-agent lifecycle check with the actual runtime diagnosis. The loop integration test passed 1/1 and confirmed this runtime failure refuses before recon and creates no `.dream-rsi` state. The contained metric-qualification integration also fails with the same exit code. Typecheck passed; recon tests passed 19/19; the two-iteration dream test passed 1/1; all 24 live/dream tests passed; and the regression file passed 17/17. The shell and curl canaries confirm that the command client ran before testing host-file and loopback denial. A remote-model broker is not implemented.

### Ledger head checkpoint follow-up

The hash-linked JSONL ledger now writes a separate head checkpoint with the exact file digest, byte length, entry count, and terminal record id/hash. A required marker prevents a missing checkpoint from making a shortened ledger look like an unanchored legacy file. Writers can repair one complete record that reached disk before a checkpoint update, including a final record without its newline. Truncation, malformed checkpoints, or more than one record of checkpoint lag fail closed. The checkpoint and marker live beside campaign history, so coordinated rewriting or deletion of all ledger and checkpoint files remains outside this protection.

Verification on the current tree:

```powershell
npm run typecheck
node --test tests/ledger.test.mjs
node --test --test-name-pattern="campaign pays for the baseline first and reserves the probe before spawn" tests/campaign-runtime.test.mjs
git diff --check
```

Typecheck passed, ledger tests passed 11/11, and the campaign integration case passed 1/1. The full suite was not rerun after this ledger change. These are local integrity checks, not an independent external ledger witness.
