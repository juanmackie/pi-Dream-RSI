---
name: dream-rsi-improve
description: Run a bounded Dream-RSI campaign that improves a chosen repository, file, project, or idea against a verified goal. Use for `/dream-rsi improve`, or when a user explicitly asks to optimize or improve a target through Dream-RSI.
---

# Improve a chosen target

Use this skill for an explicit improvement request. The request authorizes the controller to apply and repeat verified, in-scope wins within its stated limits. Do not ask for approval after each verified win.

For `/dream-rsi assess` or a request to choose what to improve, read `skills/dream-rsi-assess/SKILL.md` and stop after the assessment.

If the user asks to improve a target but gives no measurable goal, first assess that target and present up to
three evidence-backed goals. Wait for the user to choose one; do not invent the goal or start a campaign yet.

## Resolve the target and goal

Use the target and goal in the user's request. If the user names only a goal, use the active project at the current working directory. If the user names a file or subtree, bound the campaign to that scope and name related paths only when the goal needs them.

For a pasted program or idea that has no project yet, prepare a managed target workspace under `.dream-rsi/targets/<slug>/`. Keep the campaign state in its own campaign directory. For a remote repository the user names, use a managed local clone, record its origin and starting revision, and never push changes. Preserve any existing user edits. If the target cannot be resolved without guessing, ask one focused question before running the campaign.

Inspect the target before configuring it. Read its goals, implementation, tests, package scripts, CI, benchmark harnesses, and relevant recorded outcomes. Define a narrow scope, correctness gates, and one goal-specific improvement metric.

## Build and check the evaluator

Search for an existing benchmark, test harness, or project check that measures the requested outcome. The scoring command must invoke a fixed evaluator wrapper outside the candidate workspace. Because it runs from a scratch copy of that workspace, reference an external wrapper by its canonical absolute path. A workspace-local test command is editable by live agents before it scores their attempts, so it cannot serve as the trusted verifier by itself. Wrap and pin existing project tooling when it provides a trustworthy measure; keep evaluator code, acceptance fixtures, and configuration in a protected location outside candidate-editable paths. Pass their paths in `verifier_inputs`: use project-relative paths for files under the project, or canonical absolute paths for external trusted files. The controller records and freezes their identity. The candidate program remains the input under evaluation; the candidate must not be able to change the oracle or acceptance cases.

If no suitable evaluator exists, derive one from the user's stated goal and the project's existing contracts. Keep generated acceptance cases separate from candidate files. Before candidate work, the controller runs the fixed evaluator twice on the unchanged target. Both baseline scores must be valid, finite, and within `minimum_gain` of each other. This repeat is a sanity check for agreement; two measurements do not characterize noise or establish statistical confidence.

Passing tests are correctness evidence, not proof of improvement. Add a goal-specific metric such as latency, memory, output quality under explicit acceptance cases, or a count of completed requirements. If the baseline already satisfies every acceptance case and no separate metric has measurable headroom, stop and ask the user to choose another goal.

Use a deterministic evaluator when possible. For noisy measurements, the evaluator itself must run a paired, repeated protocol and return its aggregate score for each controller invocation. Set `minimum_gain` in normalized-score units from known variability; the controller uses it both as the allowed difference between the two target baseline scores and as the minimum strict gain required for promotion. It defaults to `0`. The two controller baseline calls are only a consistency check, not an estimate of variability. If you cannot implement a repeat protocol and justify a tolerance from known variability, stop and ask the user how to measure the goal.

Keep candidate changes inside the declared `scope`. Exclude evaluator files, fixtures, secrets, and campaign state from candidate edits. Identify additions, updates, and deletions in the candidate patch. If a candidate escapes scope or the target changes during evaluation, stop without applying it.

## Start the campaign

Before spending evaluator calls, call `dream_rsi_improve` with `action: "status"`. Confirm its loaded
extension path is the intended package and its evaluator timeout cap supports the fixed evaluator.
The current ceiling is 300,000 ms; set `task.evaluator_timeout_ms` explicitly for a slow evaluator.
After local source changes, reload the active pi session and recheck status. Confirm the effective
timeout in campaign progress and `campaign.json`. Count two baseline evaluator starts in the
authorized campaign budget before allocating candidate calls. A failed campaign is terminal;
resolve its evaluator failure and start a new campaign rather than resuming it.

Prepare a direct task specification for the selected target. Do not reconfigure an unrelated legacy `.dream-rsi/task.json`. The task names the workspace, candidate program, evaluator command and output fields, score direction, problem statement, and budgets. Call `dream_rsi_improve` with `action: "start"`, the goal, the resolved `project_dir`, the task, the scope, verifier input paths, and `minimum_gain` when the evaluator has a justified nonzero tolerance. Leave it omitted for exact deterministic scores.

The runtime owns all paid candidate work and promotion after intake. It runs the online exploration, replays the recorded worlds, revises the exploration policy, verifies up to three ranked candidates per cycle against the current promoted target, and applies at most one verified win per cycle. It then starts the next cycle from the promoted target.

The default campaign limits are:

| Limit | Default |
|---|---:|
| Cycles | 5 |
| Workers (`W`) | 2 |
| Online rounds (`K1`) | 3 |
| Replay rounds (`K2`) | 4 |
| Policy versions (`M`) | 2 |
| Parallel worlds (`loops`) | 1 |
| Agent starts | 36, including the initial probe, retries, and policy revisions |
| Evaluator starts | 100, including both target-baseline checks |
| Campaign deadline | 60 minutes from controller start (after intake) |
| Consecutive completed cycles without a verified gain | 2 |
| Candidate verifications | At most 3 per cycle |
| Applied patches | At most 1 per cycle |

Intake has a separate budget. Report intake work and the campaign limits before starting. The 60-minute deadline is shared by all campaign phases. It does not restart when the campaign resumes. Stop or resume with the same campaign record. There is no deadline-renewal action.

Honor requests for a smaller run by passing `max_cycles`, `max_agent_starts`, or `max_evaluator_runs` to
the start action. These values can lower the fixed ceilings only. The deadline and plateau rule are fixed;
resume continues the saved budget and deadline without renewal.

## Let the runtime finish the loop

After `start`, the controller owns live exploration, policy replay and revision, candidate verification, patch application, and stop decisions. Do not call the legacy `dream_rsi_live`, `dream_rsi_dream`, or `dream_rsi_apply` tools to continue this campaign.

Use `dream_rsi_improve` actions as follows:

- `status` reports the active campaign, phase, cycle, limits, best verified score, no-gain cycle count, and stop reason.
- `stop` asks the controller to stop at a recoverable checkpoint.
- `resume` continues the active campaign with its saved task, target, evaluator, remaining call budget, and deadline.

The controller stops at the first of these conditions: two completed cycles have no verified gain against the latest promoted target, five cycles finish, the agent or evaluator cap runs out, or the deadline expires. A failed or unavailable evaluator is not a plateau. Report it as `unverifiable`, explain the failure, and ask for the measurement decision needed before starting a new campaign. Do not describe a failed campaign as paused or resume it without resolving the evaluator issue.

If the baseline cannot be scored, the evaluator is noisy without a declared tolerance, generated acceptance cases have no headroom, or the project cannot support a defensible improvement measure, do not call `start`. Explain the evidence and ask the user to choose a measurable goal or review a proposal without automatic promotion.

## Preserve the manual workflow

`/dream-rsi create`, `live`, `dream`, `run`, and `resume` keep their existing task-based behavior. `create` configures a task and stops before spending a cycle. `/dream-rsi improve` is the explicit route for a full bounded campaign that applies verified wins automatically.
