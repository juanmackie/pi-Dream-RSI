# Changelog

## 1.0.1

Release version only: the campaign-first 1.0.0 merge did not publish to npm. This version makes the 1.0 release available; product behavior is unchanged from 1.0.0.

## 1.0.0

Dream-RSI now guides project improvement through bounded campaigns.

- Added project signals and lever assessment, including bounded session-log summaries and `--no-logs`.
- Added plain-language campaign intake, evaluator check, calibrated baseline noise, and paired verification.
- Added correctness gates and adversarial review before in-scope changes are applied.
- Added campaign status, stop, resume, and framed watch commands with live session model resolution.
- Preserved prior manual task and history data on disk. The 1.0 commands do not read or migrate it.
- Kept version 1 campaign records loadable. Paused campaigns resume with their saved goal, scope, verifier identity, remaining budgets, and deadline.
- Removed the manual create, suggest, live, dream, run, and candidate-ranking command workflow.

This release changes the user-facing workflow. Existing manual-loop data is retained as legacy data and does not become a campaign automatically.
