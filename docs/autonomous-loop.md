# Autonomous loop

Dream-RSI runs a bounded loop over a local project. It ranks measurable levers, qualifies an evaluator, explores candidate changes in isolated workspaces, and applies a change only after confirmation, gates, and adversarial review. An independent post-apply check verifies the result.

## Consent and budgets

Start with `dream_rsi_loop` and `consent: true`. Consent accepts that project code, evaluators, gates, and agents run on the host with the host user's access. Dream-RSI does not contain hostile code.

Defaults are 6 campaigns, 72 agent starts, 200 evaluator runs, and 120 minutes. Budgets persist across runs under `.dream-rsi/loop/` and are not renewed on resume. A campaign receives at most 18 agent starts, 48 evaluator runs, and 60 minutes from the remaining allowance.

The tool accepts a focus, optional evaluator and gates, editable scope, protected assets, command categories, environment allowlist, and budget caps. A metric unit and direction do not define an evaluator command. A score evaluator must be explicitly declared. Dream-RSI does not silently replace a metric with wall-clock time; a proxy needs an explicit justification.

Startup records a preflight report with separate metric, evaluator, workload, scope, and gate checks. Contract consent means the trusted-local settings were accepted and saved; it does not mean that a workload is measurable or that a campaign can start. Missing instrumentation or required out-of-scope files stop the run as `blocked`, name the missing item, and give a next step. `no-verifiable-lever` is reserved for a completed assessment that found no eligible lever. No campaign is counted when a preflight blocker prevents campaign start.

Evaluator bootstrap is opt-in. Set `evaluator_bootstrap.authorized` to `true` and list the exact project-relative files it may create or update. Every path must be inside editable scope, and the approved command categories must permit a benchmark or custom workload. The bootstrap agent edits an isolated project copy; Dream-RSI copies back only the listed files, then runs discovery against the resulting workload before ranking. The metric, unit, and direction remain the approved ones. If a required gate or bootstrap path is outside scope, the loop stops and names the paths instead of expanding scope.

Run reports count all evaluator invocations this run and break them out by phase. Discovery and qualification are reported as preflight spend, separately from campaign evaluator runs. Durable counters remain cumulative across runs; compare run deltas with the durable budget rather than treating the cumulative phase totals as this run's spend. Score evaluators can return one number on stdout, a valid score JSON object on stdout, or write the declared score file. Qualification checks known oracle prerequisites before evaluator runs and admits a search only when its remaining budget can fund gates, an initial confirmation look, review, and independent post-apply verification. Expected reading duration sizes the budget; the process timeout remains a separate kill limit.

## Experiment and dream cycle

Each campaign uses a bounded hill climb with a fixed, qualified metric. Attempts run in isolated workspaces; the campaign confirms candidate gains, runs correctness gates and adversarial review, then applies an accepted patch. The loop checks the applied result independently before it starts another campaign.

Completed experiments are recorded as worlds. When enough eligible worlds exist, the dream step can ask an agent for bounded search-config proposals. Deterministic replay scores each proposal using only recorded branch and refinement attempts. The incumbent remains a candidate, and only a challenger with sufficient coverage and a clear score margin is adopted. Dream output is configuration data; it does not provide executable policy code.

## State and recovery

Project state lives under `.dream-rsi/`. Campaign records and append-only attempt evidence are retained. Search configs, dream decisions, durable budgets, and the latest typed stop-code report live under `.dream-rsi/loop/`. Temporary evaluator and gate workspaces stay under `.dream-rsi/runtime/`; copies exclude Dream-RSI state so a run cannot inspect its own scratch data. Each attempt starts a fresh agent process and receives prior notes and experiment history.

`status` reports progress and spend, including any pending paired confirmation. `stop` pauses the active campaign. `resume` restarts an interrupted attempt and continues the loop. If a candidate needs another confirmation look, `confirm` resumes its saved readings and pairs without repeating completed evaluator calls; it uses only the remaining durable loop allowance, keeps the post-apply verification reserve, and does not start a new search. Gates, review, and independent post-apply verification still run before the result is recorded as a win. A paused 2.x campaign is marked failed with the 3.0 restart path; stored v1 loop contracts are normalized when read.

Applied changes remain in the working tree. Review the diff, then keep or revert it with Git.
