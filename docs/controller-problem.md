Improve campaign selection and budget control in `extensions/pi-dream-rsi/engine/campaign.ts`.

The protected evaluator imports the candidate controller and runs isolated projects with scripted agents.
It judges final target bytes with an independent scorer and correctness gate, checks evaluator integrity,
and counts observed subprocess starts. False applies invalidate the result. The score is verified wins
per observed agent start. A forged ledger or status record is not evidence of a win.

Preserve runtime intake checks, direction and threshold semantics, scoped patches, gates, review,
process budgets, recovery journals, and verifier integrity. Change only the declared controller file.
