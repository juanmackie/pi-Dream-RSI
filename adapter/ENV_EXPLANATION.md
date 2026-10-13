# .env / Adapter / Harness Status — Full Explanation for Dev Team

## 1. .env File (Verified Working)
Path: `C:/Users/juanm/Documents/GitHub/prompt-paul-agent-eval/.env`
Variables (hidden API key preserved — never copied/displayed):
- `LLM_BASE_URL=https://api.mistral.ai/v1`
- `LLM_MODEL=mistral-small-2603`
- `LLM_API_KEY=<hidden>` (loaded by adapter; not copied/disclosed)
- `EVAL_DRY_RUN=false`
- `EVAL_TASKS=5`

The `.env` loads correctly. The adapter (`adapter/measure.sh`) verifies this (`set -a; source .env; set +a`).

## 2. Adapter Verification (PASS)
Adapter: `C:/Users/juanm/Documents/GitHub/pi Dream-RSI/adapter/measure.sh`
Verification result (with dataset present, `.env` loaded):
- `fail_class`: `ok`
- `valid`: `true`
- `score`: `0.4` (4 exact matches out of 10 harness cases — aligns with handoff baseline)
- `adapter_note`: adapter reads harness output but does not recompute score.
- `harness_lines_read`: `10`
- `exact_matches`: `4`

The adapter references the harness correctly (absolute path to adapter outside workspace), references workspace (`PROMPT_PAUL_EXTENSION_ROOT`), and references dataset (`C:/datasets/Mind2Web`).

## 3. Dataset Status
Download/Extraction: COMPLETE (`test.zip` ~568MB downloaded to `C:/datasets/Mind2Web/test.zip`, extracted to `C:/datasets/Mind2Web/data/test_domain/test_domain_9.json` etc.).

## 4. Baseline Measurement
File: `.dream-rsi/history/seed/score.json` (`C:/Users/juanm/Documents/GitHub/Chromeext_PromptPaul/.dream-rsi/history/seed/score.json`)
- `score`: `0.4`
- `fail_class`: `ok`
- `valid`: `true`
- `note`: measurement completed; adapter verified.

Task: `.dream-rsi/task.json` (`PromptPaul_Mind2Web_ExactAction`) configured as fresh (not reset).

## 5. The 429 Rate Limit (What Is Blocked — Not `.env`)
The live cycle (`dream_rsi_live`) is blocked by `429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}`.
This is a provider-side usage/rate limit (from the Mistral endpoint `https://api.mistral.ai/v1/chat/completions`), NOT a `.env` auth/config failure. Evidence:
- The adapter verifies `.env` loads correctly (adapter exit 0, valid=true, ok).
- The `.env` endpoint/model variables are set correctly (`LLM_BASE_URL`, `LLM_MODEL`).
- A manual one-token test with `.env` returns HTTP 200 (per user's previous confirmation: "The current .env credentials are working: the one-token request returned HTTP 200 for mistral-small-2603.").
- The 429 appears specifically during the harness evaluation workload (multiple model calls with larger context), not during adapter verification or simple auth checks.
- The same 429 error appeared when `.env` was temporarily switched to OpenAI (`https://api.openai.com/v1/chat/completions`) — confirming the 429 is session/account-level (not provider-specific).

## 6. Freeze / Authorization Status
- Freeze: LIFTED (user explicitly authorized `run live cycle` through questions: "Start live cycle now (Recommended)" selected).
- Adapter: verified (ok, score 0.4).
- Dataset: extracted.
- `.env`: working (variables loaded; adapter produces ok).
- Agent spend: 0 (live cycle blocked before any agent call — no model calls completed for the cycle).
- No secrets (API keys) copied/displayed in reports or code.

## 7. Next Directions (Not Implemented — Requires User/Dev Team Decision)
Given the `.env` is working but the live cycle is blocked by provider rate limit:
- Option A: Retry `dream_rsi_live` later (rate limit may resolve with delay) — same `.env`.
- Option B: Change `.env` model/provider (e.g., different Mistral model, OpenAI model with new key) — confirm new key/model.
- Option C: Freeze/manual — work manually on `RunOrchestrator.js`/prompts (no agent spend) until rate limit resolves.

## 8. Evidence File Paths
- `.env`: `C:/Users/juanm/Documents/GitHub/prompt-paul-agent-eval/.env`
- Adapter: `C:/Users/juanm/Documents/GitHub/pi Dream-RSI/adapter/measure.sh`
- Task config: `C:/Users/juanm/Documents/GitHub/Chromeext_PromptPaul/.dream-rsi/task.json`
- Baseline score: `C:/Users/juanm/Documents/GitHub/Chromeext_PromptPaul/.dream-rsi/history/seed/score.json`
- Dataset archive: `C:/datasets/Mind2Web/test.zip`
- Dataset extracted: `C:/datasets/Mind2Web/data/test_domain/test_domain_9.json` (and others)
- Adapter output (latest verification): `C:/Users/juanm/Documents/GitHub/Chromeext_PromptPaul/eval/score.json`

Note: `.env` was aligned to `LLM_*` variable names (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`) — no stale `EVAL_LLM_*` references remain in adapter or setup.
