---
name: dream-rsi-loop
description: Prepare and run the unattended multi-lever Dream-RSI loop for a repository, project, or file. Use for an explicit request to improve or optimize a target without supervising one campaign at a time.
---

# Run the unattended loop

Choose this flow when the user explicitly asks for improvement and wants it run unattended across several candidate improvements. For one targeted change with a known evaluator, keep `dream_rsi_improve`. The loop re-runs the assessment itself: it ranks levers from project signals, synthesizes and calibrates a metric for the chosen lever when intake has none, chains bounded campaigns until a verified win is applied, then re-ranks from fresh evidence.

Start with `dream_rsi_loop`, `action: "start"`, `project_dir`, and the user's intent as `focus`. Set the durable caps explicitly when the user names a budget. Defaults: 6 campaigns, 72 agent starts, 200 evaluator runs and 120 minutes per run, with a plateau stop after 3 campaigns without a verified win.

To work on a repository with no recorded evidence, pass a `contract`. It is the one place the run's objective, permissions and spend are decided, and nothing autonomous can widen it afterwards. Fill in one primary outcome with its unit and direction, the smallest change worth applying, the preserved gates, the editable roots and protected assets, trusted-local consent, the allowed command categories, the approved providers, and the durable budgets. Ask the user to supply the objective and the consent rather than inventing them.

`execution.consent` must be `true` before any probe runs, and it is a risk acceptance, not a sandbox: discovered repository code runs on this host with host access. Say that plainly when you ask for it. Only point the loop at repositories the operator would run by hand, and never approve a contract for an unfamiliar or hostile repository on their behalf.

`envAllowlist` is the entire environment for discovery probes, the generated instrument and the post-apply check. It does not cover campaign scoring and gates, which run with the host environment minus session identity because project-declared commands normally need `PATH`. Do not tell the user that a contract withholds all credentials from every process; state the per-phase scope.

Pass `control_patch` (a known-better change for the metric, relative to `project_dir` or absolute) whenever one exists. Every supplied control is validated during evaluator preflight.

Without a control patch, a contract run qualifies the instrument from independent evidence: the workload must complete on the unchanged target, reproduce its own baseline, respond to a degraded control in the same measured operation, reject a workload that does not exist, and fail an inert version of the editable code at its declared correctness commands. A lever that fails any check is rejected with the exact reason. A run without a contract keeps the older path, where a lever that needs a new metric is recorded as rejected instead of explored.

Give each workload enough real work that the smallest worthwhile change is larger than the machine's jitter, or the loop will refuse the instrument as unable to resolve it. That refusal is correct, not a bug to work around: do not lower the threshold or the oracle to get past it.

Each chained campaign is a full campaign: evaluator preflight, isolated candidate workspaces, paired confirmation, correctness gates, adversarial review, and at most one scoped apply with a recovery journal. Applied patches stay uncommitted in the working tree.

Stop reasons: `budget`, `deadline`, `plateau`, `blocked` (an unfinished campaign exists; resume or stop it first), `cancelled` (a stop request arrived), `empty inventory`, `no verifiable lever`, `not-approved` (a contract is missing, refused, or names a different objective than the stored one), `campaign failed`, and `post-apply check failed`. Report the stop reason, campaigns and verified wins, the independent post-apply checks, spend against the durable caps, and the memory path. Use `action: "status"` for the durable budget, phase spend, stored contract, optimizer generation, lever memory and the active campaign.

Every applied change is verified once more from outside the campaign against the baseline recorded before any candidate ran. If that check fails the run stops: do not resume it as if the change were verified.

Optimizer trials are off unless `optimizer_trials` is set and a harness that owns a sealed confirmation split is configured. Report `champion retained` outcomes with their reason instead of implying the tool improved itself.

Never edit `.dream-rsi/loop/` by hand. Loop budgets and limits are immutable once a loop state file exists; to reset, move the loop state directory aside first. Scheduling, committing, pushing, and publishing remain separate actions.
