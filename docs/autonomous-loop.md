# Autonomous loop

Dream-RSI runs a bounded loop over a local project. It ranks measurable levers, qualifies an evaluator, explores candidate changes in isolated workspaces, and applies a change only after confirmation, gates, and adversarial review. An independent post-apply check verifies the result.

## Consent and budgets

Start with `/dream-rsi loop [goal]`. The command asks for consent in an interactive session and starts the loop itself. It does not need the chat model to call a tool. In a non-interactive session, pass `--consent` to accept consent in the command, or let the command send the request to the chat model. Add `--no-logs` to skip reading local session files.

Consent accepts that project code, evaluators, gates, and agents run on the host with the host user's access. The tool `dream_rsi_loop` with `action: "start"` and `consent: true` starts the same loop.

Defaults are 6 campaigns, 72 agent starts, 200 evaluator runs, and 120 minutes. Budgets persist across runs under `.dream-rsi/loop/` and are not renewed on resume. A campaign receives at most 18 agent starts, 48 evaluator runs, and 60 minutes from the remaining allowance.

The tool accepts a focus, optional evaluator and gates, editable scope, protected assets, command categories, environment allowlist, and budget caps. A metric unit and direction do not define an evaluator command. A score evaluator must be explicitly declared. Dream-RSI does not silently replace a metric with wall-clock time; a proxy needs an explicit justification.

Startup records a preflight report with separate metric, evaluator, workload, scope, and gate checks. Contract consent means the trusted-local settings were accepted and saved; it does not mean that a workload is measurable or that a campaign can start. Missing instrumentation or required out-of-scope files stop the run as `blocked`, name the missing item, and give a next step. `no-verifiable-lever` is reserved for a completed assessment that found no eligible lever. No campaign is counted when a preflight blocker prevents campaign start.

Evaluator bootstrap is opt-in. Set `evaluator_bootstrap.authorized` to `true` and list the exact project-relative files it may create or update. Every path must be inside editable scope, and the approved command categories must permit a benchmark or custom workload. The bootstrap agent edits an isolated project copy; Dream-RSI copies back only the listed files, then runs discovery against the resulting workload before ranking. The metric, unit, and direction remain the approved ones. If a required gate or bootstrap path is outside scope, the loop stops and names the paths instead of expanding scope.

Run reports count all evaluator invocations this run and break them out by phase. Discovery and qualification are reported as preflight spend, separately from campaign evaluator runs. Durable counters remain cumulative across runs; compare run deltas with the durable budget rather than treating the cumulative phase totals as this run's spend. Score evaluators can return one number on stdout, a valid score JSON object on stdout, or write the declared score file. Qualification checks known oracle prerequisites before evaluator runs and admits a search only when its remaining budget can fund gates, an initial confirmation look, review, and independent post-apply verification. Expected reading duration sizes the budget; the process timeout remains a separate kill limit.

## Agent health

Before the first campaign the loop spends one agent start on a liveness probe. The probe runs the effective agent in a copy of the task workspace and asks for a short reply. A missing command, an exit code other than zero, or a reported model or provider error stops the run as `blocked` and names the agent command and the model. In the agent's JSON mode an empty reply also stops the run. The probe is charged to the durable budget and never starts after the run's deadline.

During a campaign the loop reads the agent's JSON output. A run that ends with a model or provider error is an `agent_error`, not an ordinary no-gain attempt. An error that the agent retried and recovered is not a failure. An agent that exits with a failure code is an `agent_error` too. Three consecutive attempts that fail without changing the workspace stop the run as `blocked` and name the agent command and the model. A healthy attempt between two failures breaks that run of failures. The status output shows the command and the model that the child process really used. A child default model is shown as such when no session or saved model was resolved.

## Experiment and dream cycle

Each campaign uses a bounded hill climb with a fixed, qualified metric. Attempts run in isolated workspaces; the campaign confirms candidate gains, runs correctness gates and adversarial review, then applies an accepted patch. The loop checks the applied result independently before it starts another campaign.

Completed experiments are recorded as worlds. When enough eligible worlds exist, the dream step can ask an agent for bounded search-config proposals. Deterministic replay scores each proposal using only recorded branch and refinement attempts. The incumbent remains a candidate, and only a challenger with sufficient coverage and a clear score margin is adopted. Dream output is configuration data; it does not provide executable policy code.

## State and recovery

Project state lives under `.dream-rsi/`. Campaign records and append-only attempt evidence are retained. Search configs, dream decisions, durable budgets, and the latest typed stop-code report live under `.dream-rsi/loop/`. Temporary evaluator and gate workspaces stay under `.dream-rsi/runtime/`; copies exclude Dream-RSI state so a run cannot inspect its own scratch data. Each attempt starts a fresh agent process and receives prior notes and experiment history.

`status` reports progress and spend, including any pending paired confirmation. `stop` pauses the active campaign. It also stops a loop that is running in this session, even before that loop has a campaign record, when the requested project matches the run (or no project is specified). If a stop request names another project, the tool reports that the session's run remains active and does not abort it. The run keeps its session slot until cancellation unwinds; a new start during that interval reports that the run is still stopping. `resume` restarts an interrupted attempt and continues the loop. If a candidate needs another confirmation look, `confirm` resumes its saved readings and pairs without repeating completed evaluator calls; it uses only the remaining durable loop allowance, keeps the post-apply verification reserve, and does not start a new search. Gates, review, and independent post-apply verification still run before the result is recorded as a win. A paused 2.x campaign is marked failed with the 3.0 restart path; stored v1 loop contracts are normalized when read.

In a TUI session, an executing start, resume, or confirmation shows an animated status. Campaign phase details continue through progress updates and the dashboard. One loop run may own a session at a time; another start, resume, or confirmation is rejected without replacing its status. On completion, cancellation, or failure, the status returns to the active-mode label. Non-TUI sessions do not show the animation.

A loop started by the command runs detached from the chat turn in an interactive session. It sends the final report into the session. A one-shot session waits for the run and writes the final report to the standard error stream. Closing the session clears the animation and aborts the run, so no agent process outlives the session.

Applied changes remain in the working tree. Review the diff, then keep or revert it with Git.
