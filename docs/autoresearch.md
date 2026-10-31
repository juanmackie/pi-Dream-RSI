# Trusted-local auto experiments

Dream-RSI auto is an opt-in experiment loop for one trusted local Git repository. It runs the declared measure and check commands on the host. It is not a sandbox. Do not use it on an untrusted repository or shared host.

## Start and resume

Run `/dream-rsi auto <goal>`. Review the objective, numeric measurement command, correctness command, editable scope, minimum gain, experiment caps, provider-side hard cap, and dedicated branch before initialization. The extension asks for trusted-local consent. The provider cap must also be configured at the provider; Dream-RSI records the declared amount but does not enforce per-call spend or verify provider configuration.

`dream_rsi_auto_init` qualifies five baseline readings and the unchanged-tree check before it creates state and selects a dedicated branch. Init also requires an available Git repository, a clean tree outside Dream-RSI state, and a non-default dedicated branch. The baseline coefficient of variation must be at most 5%. State is stored in `.dream-rsi/auto/`:

- `config.json` holds the approved settings and current progress.
- `measure.sh` and `checks.sh` retain the declared commands.
- `log.jsonl` is append-only.
- `prompt.md` is the compact resume document.

For each experiment, edit only the declared scope, call `dream_rsi_auto_run`, then call `dream_rsi_auto_log` with a concise description and hypothesis. The run tool measures but never commits. The log tool runs the check on a clean temporary copy. A passing check and a confirmed gain above the declared minimum are required before the existing verified commit path creates a local commit. Failed checks and non-improving candidates are discarded, including scoped untracked files. The append-only log stores only a bounded tail in the resume prompt. The loop stops at the experiment cap, consecutive-discard cap, provider quota rejection, or operator request.

Consent is bound to the resolved repository path in the current pi session. If the working directory changes to another repository, approve auto again there before init, run, or log can execute commands.

Init builds its files in a staging directory and publishes the state directory only when the config, command files, baseline log, and prompt are complete. If a process stops before publication, run init again. Run logging is replayable across interruption: it reconciles an exact committed postimage, an already-appended log row, or a completed discard before advancing the session. An incomplete final log line is removed before the next append. A staged Git index is reused only when its paths and staged postimages match the pending verified run; otherwise auto refuses and preserves the index for inspection. Do not clear or reset an index to recover a run.

A fresh pi session must run `/dream-rsi auto resume` to resume from the saved prompt and log. `/dream-rsi auto status` is read-only. `/dream-rsi auto off` stops at the next run boundary; log an in-flight run to preserve its result. It does not push or merge.

## Limits

The mode is not a background service. Pi's agent turn is the search policy. Transient provider errors may request up to two continuations; the third transient failure stops the session. A provider key cap is not an in-process spend control. No self-improvement, arbitrary-repository safety, or magnitude claim is made. Noisy baselines above 5% CV are refused. The six-repository pilot and full evidence track are separate local tooling; do not run paid or external-repository studies without separate approval.
