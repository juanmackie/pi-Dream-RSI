### Use the Mind2Web scorer

The repository helper `adapter/measure.sh` delegates to
`adapter/dream-rsi-mind2web-score.mjs`. You can invoke Node directly without a shell:

```text
node "/absolute/path/to/pi-dream-rsi/adapter/dream-rsi-mind2web-score.mjs" "/absolute/path/to/candidate-workspace"
```

Configure these environment variables before invoking the scorer:

| Variable | Value |
|---|---|
| `DREAM_RSI_HARNESS_DIR` | Absolute path to the PromptPaul evaluation harness |
| `DREAM_RSI_DATASET_DIR` | Absolute path to the extracted Mind2Web dataset |
| `DREAM_RSI_CASES_FILE` | Absolute path to the pinned manifest of ten `test_domain` cases |
| `DREAM_RSI_EXPECTED_MODEL` | Exact model ID used for every baseline and candidate measurement |
| `DREAM_RSI_EXPECTED_PROVIDER_HOST` | Expected provider hostname, including a port if present |

The harness `.env` supplies `LLM_MODEL`, `LLM_BASE_URL`, and `LLM_API_KEY`. The scorer checks the
model and provider against the explicit pins, builds the candidate, and runs three evaluations at
temperature zero. Each repeat must produce ten rows in a fresh output file. The scorer validates
the runner summary, run IDs, manifest hash, ordered case IDs, model, temperature, and provider-call
counts before writing `eval/score.json`. Keep the scorer, manifest, harness, and provider configuration
outside candidate-editable paths and include their fixed inputs in `verifier_inputs`.

The score includes the aggregate, per-repeat scores, run IDs, manifest hash, and pinned provider
identity. Successful runs retain their three JSONL artifacts under `eval/mind2web-run-*`.
Use the same pinned model and manifest
for baseline and candidate comparisons. Temperature zero does not establish determinism for a
hosted model. Choose `minimum_gain` from measured variation under the repeated protocol.
Historical scores from the old preparation-only adapter are untrusted and require remeasurement.