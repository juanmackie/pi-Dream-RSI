Improve `extensions/pi-dream-rsi/engine/measure.ts`, which makes paired measurement decisions for campaign evaluation. Keep decisions deterministic and finite. Preserve strict threshold semantics, reject invalid measurements, stop futile tests, and keep false accepts within the fixed alpha on both primary and held-out DreamBench seeds.

The protected scorer dynamically loads the candidate `measure.ts` from the attempt workspace and compares it with the byte-verified baseline. DreamBench uses fixed numeric scenarios in the protected `eval/scenarios.json`. The objective is primary-set
`J = positive-scenario power - 0.25 * (mean evaluator runs / 16) - 0.01 * (delta code tokens / 50)`.
The held-out J and primary/held-out power must each remain within 0.005 of baseline; one-sided exact false-accept upper bounds must not exceed alpha. Token counts exclude comments and whitespace. The scorer writes `eval/score.json`.

Write a proposal before editing. Change only the declared candidate file. Do not read, change, or specialize the evaluator, scenarios, gate, or baseline. The host runs `npm test` as a separate gate.
