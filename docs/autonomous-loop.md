# Run the autonomous loop

Dream-RSI can be pointed at a repository it has never seen and run unattended: it
finds a measurable bottleneck, builds and qualifies its own instrument, runs
bounded experiments, applies a verified improvement, checks that improvement
independently, and repeats until it runs out of headroom or budget.

This page describes what that run does, what it will refuse, and what it cannot
claim.

## One approval, then unattended work

Autonomy is bounded by an approved **run contract**. It is the only place a run's
objective, permissions and spend are decided, and no autonomous step can widen it.

```jsonc
{
  "version": 1,
  "outcome": {
    "statement": "reduce the wall-clock duration of the declared benchmark command",
    "unit": "ms",
    "higherIsBetter": false,
    "minimumUsefulGain": "25%"
  },
  "preserved": { "gates": [] },
  "scope": { "roots": ["src"], "protectedAssets": ["test"] },
  "execution": {
    "mode": "trusted-local",
    "consent": true,
    "envAllowlist": [],
    "allowedCommandCategories": ["test", "benchmark"]
  },
  "models": { "providers": ["anthropic"] },
  "budgets": {
    "maxCampaigns": 6,
    "maxAgentStarts": 72,
    "maxEvaluatorRuns": 200,
    "deadlineMs": 7200000,
    "falseAcceptBudget": 0.01,
    "optimizerTrials": 1
  }
}
```

- One primary outcome with hard constraints. Do not combine latency, correctness
  and code size into an invented weighted score. If the scored metric is a proxy,
  say why it is a valid one.
- `minimumUsefulGain` is the smallest change worth applying: a number in the
  outcome's units, or a percentage.
- `scope.roots` limits what a candidate may edit. `scope.protectedAssets` and
  `preserved.gates` are what must keep working.
- `envAllowlist` is what these processes may see *in addition to* a fixed
  non-secret runtime baseline (`PATH`, and on Windows the command interpreter,
  `SystemRoot`, `PATHEXT`, temp directories). That baseline is what lets any process
  start at all; without `PATH` a probe fails with "command not found" on a machine
  whose runtime is not in the shell's default search path. It applies to discovery
  probes, the generated instrument and the independent post-apply check.
  Credentials, provider keys and session identity are withheld from all of them.

  It does **not** cover the campaign phase. The campaign engine runs the scoring
  command and the correctness gates with the host environment minus session
  identity, because those commands are project-declared and normally need `PATH`
  and toolchain variables. Repository code executed there can therefore read
  operator environment variables. Treat that as part of the trusted-local risk
  acceptance below, and put a variable in `envAllowlist` only when a probe
  genuinely needs it.

Run it with `/dream-rsi loop <what you want>` and a `contract` payload, or start
an approved contract headlessly. The contract is stored under
`.dream-rsi/loop/contract.json`; a run that names a different objective is refused
rather than silently replacing it.

### Trusted-local means trusted, not contained

`execution.mode` is `trusted-local`: discovered repository code runs as a host
process with host access. A workspace copy and a hash check are not a sandbox.

Before approving a contract, understand what that means:

- The repository's own scripts run on this machine, with this user's filesystem and
  network reach.
- A prompt injection or a hostile script is not contained.
- Only point it at repositories you would run by hand.
- Missing dependencies are a setup blocker; the tool does not install anything.
- Restricted environment coverage is per phase: probes, the generated instrument
  and the post-apply check get only `envAllowlist`; campaign scoring and gates get
  the host environment (minus session identity).

The mitigations are narrow environment allowlists, an explicit refusal before any
probe without consent, path and secret filtering of what discovery reads, and
approval of the command categories that may run.

## What one iteration does

1. **Recon.** Reads manifests and source, bounded by file, depth and size limits.
   Declares the project's own commands and classifies them as test, benchmark,
   build or custom. Anything outside the approved categories is reported, not run.
2. **Probe.** Runs each declared benchmark or custom workload once, in the
   restricted environment, and records its duration. A workload that fails becomes
   a named blocker.
3. **Attribute scope.** Walks that workload's local import graph. The proposed
   patch scope is the code the measurement actually exercises — not every file
   that was recently touched. Dependency, generated and secret-shaped paths are
   never followed.
4. **Author the instrument.** Generates a pinned evaluator outside the editable
   scope that runs the declared workload and writes a numeric score.
5. **Qualify the instrument.** See below.
6. **Campaign.** Runs the existing campaign engine: isolated candidate copies,
   paired before/after confirmation, correctness gates, adversarial review, and at
   most one scoped apply per cycle with a recovery journal.
7. **Verify after apply.** Takes a fresh copy of the result, runs the declared
   correctness commands, measures the same workload again, and requires the gain
   against the baseline recorded before any candidate ran. A failure stops the run.
8. **Re-rank.** Re-measures the project and continues.

## Instrument qualification

The old requirement was a caller-supplied winning patch. That made a cold start
impossible. An instrument is now qualified from independent evidence:

| Check | What must hold |
|---|---|
| workload | The declared workload completes on the unchanged target and produces a valid reading. |
| baseline | Repeated readings are recorded, with their median. |
| stability | Repeated readings spread by less than the smallest worthwhile change. A busy host can make one series jittery, so the same measurement is taken again before refusing; the thresholds never change between passes. |
| direction | More work in the same measured operation moves the score the way the contract declares. |
| sensitivity | A degraded control moves the score by more than the smallest worthwhile change. |
| missing-workload | A workload that does not exist produces an invalid score. |
| oracle | An inert version of the editable code fails the declared correctness commands. |
| budget-fit | One confirmation fits the remaining deadline. |

A synthetic delay proves *sensitivity*, not that the project has headroom. That is
why the oracle check, the workload→outcome argument in the contract, and the
independent post-apply check all exist.

If any check fails, the lever is rejected with the exact reason. That is an
autonomous refusal, not a successful optimization. A plateau is never permission
to lower the standard or switch to an unrelated objective.

## Budgeting the whole run

Every phase that can start a process spends from one durable allowance:
discovery probes, evaluator runs, instrument qualification, campaign candidates,
review, post-apply checks, and optimizer trials. A grant is written *before* the
child starts; a process that dies mid-phase leaves a reservation that the next run
charges instead of forgetting. Limits are immutable once the budget file exists;
resuming never renews them.

`falseAcceptBudget` is the run's rare-event allowance. It is divided across the
campaigns the contract permits, so confirming several campaigns does not spend the
same allowance repeatedly.

## Stopping

Stop reasons are reported verbatim: `budget`, `deadline`, `plateau`, `blocked`,
`cancelled`, `empty inventory`, `no verifiable lever`, `not-approved`, and
`campaign failed`. A post-apply check failure stops the run with
`post-apply check failed`.

An unready lever can be rejected and the run can screen the next one; an integrity
failure stops it.

## Improving the optimizer

The tool can improve its own discovery, selection and prompts, under a rule that
keeps it from certifying itself:

- A generation is content addressed. Fixed guard rails — the run contract, the
  budget, the promotion rule and the recovery boundary — cannot be part of a
  generation.
- Promotion needs a strictly positive gain on a development set **and** on a sealed
  confirmation set that has not been used before. Any fixed-safety violation, any
  preserved-behaviour regression, a cost above the declared ceiling, or too few
  paired comparisons retains the champion.
- A sealed attempt is spent whichever way the decision goes.
- Activation is durable state read by the *next* process. Nothing is hot-swapped
  into a running loop, and the previous champion is retained for rollback.

Optimizer trials are off by default (`optimizer_trials: 0`). They run only at a
plateau, and only when a harness that owns the sealed split is configured;
otherwise the loop records that the champion was retained and why.

## Verifying the tool itself

```sh
npm run typecheck
npm test                          # default suite, including the single-bottleneck cold start
DREAM_RSI_HELDOUT=1 npm test      # adds the multi-bottleneck acceptance and held-out fixtures
node eval/bench.mjs --seeds 20000
node eval/bench.mjs --held-out --seeds 5000
```

The multi-bottleneck acceptance run drives two full campaigns over real subprocesses;
it is opt-in so the default suite does not starve the other timing-sensitive
end-to-end tests of CPU. Scripted agents exercise the machinery. They do not certify
model quality, improvement rates, or behaviour on stacks outside the tested set.

## What this does not promise

- Not every repository has a measurable improvement. Unsupported stacks, missing
  toolchains, and objectives with no observable outcome stop with a reason.
- Log frequency, churn and guessed percentages do not establish priority. Priority
  comes from a measured workload and the code it exercises.
- Safe execution of hostile repositories is not provided.
- No model-weight training, deployment, or publication. Applied patches stay
  uncommitted with recovery journals.
- Claims about improvement rates need real-model trials run against independent
  semantic checks under equal budgets. Scripted tests certify the machinery, not
  the model.
