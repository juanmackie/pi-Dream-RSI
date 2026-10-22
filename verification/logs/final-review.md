## Review — fresh-context, read-only, diff-only

**Scope:** `watchdog_diff` on main at `C:\Users\juanm\Documents\GitHub/pi Dream-RSI` shows only `docs/autonomous-loop.md`, `extensions/pi-dream-rsi/index.ts`, `tests/extension.test.mjs` changed (+391/-61). No uncommitted edits outside those; `git diff --check` reported clean.

**Results cited by the task (not executed by me):** `node --test tests/extension.test.mjs` 18/18; `npm run typecheck` pass; `git diff --check` pass; `npm test` 313/316 (3 skipped); `DREAM_RSI_HELDOUT=1 npm test` 316/316 (0 skipped). No files changed since those checks. **Test-execution gap noted:** I did not personally run these; they are reported validation only. The 3 skips align with the held-out/lease-test path (see below).

---

### Verified against original lifecycle objective & prior findings

| Check | Evidence / Verdict |
|---|---|
| **Terminal status restoration** | `withLoopIndicator` finally restores `modes.get(sessionId) ? "dream-rsi: active" : undefined` (`index.ts` ~131–138); tests assert `harness.statuses.at(-1)?.[1] === "dream-rsi: active"` after finish/cancel/failure (e.g., test lines ~125, ~285, ~320, ~395). `session_shutdown` clears timer and deletes indicator (`index.ts` ~803–809). |
| **Per-session ownership (start/resume/confirm)** | `reserveLoopRun` / `releaseLoopRun` guard `activeLoopRuns`; `slot.projectDir` set to `path.resolve(projectDir)` (`index.ts` ~93–102). Tool `start` reserves before consent dialog and uses `slot.controller`; `resume`/`confirm` reserve after validation (`index.ts` ~545, ~620). Command `loop` reserves before consent (`index.ts` ~627) and releases in finally. |
| **Status arbitration** | `setStatusUnlessAnimating` skips `setStatus` when `loopIndicators.has(sessionId)` (`index.ts` ~109–111). `campaignUpdate` takes `isIndicatorActive` and skips status write when active (`index.ts` ~945–952). `onProgress` / `onPhaseProgress` / `onCampaignUpdate` pass `() => loopIndicators.has(sessionId)` so updates don’t overwrite animation. |
| **Stop target: omitted / matching / mismatched `project_dir`** | `stop` computes `requestedProject`, `retainedTarget` (`loopTargetRoot`), `targetProject`; `aborted` only when `path.resolve(targetProject) === slot.projectDir` (`index.ts` ~498–514). If `!aborted` and slot exists, returns `still running` / `still stopping` message with `slot.projectDir`. If match, aborts controller; if no campaign yet, reports “was asked to stop; no campaign is recorded yet.” |
| **Useful feedback while aborted slot unwinding** | `alreadyRunning` checks `slot.controller.signal.aborted`: “still stopping” vs “already running” (`index.ts` ~104–108). `stop` when `aborted` true does not append the mismatch line; when `slot && !aborted` appends mismatch feedback. `resume`/`confirm`/`start` return `alreadyRunning` when slot present, preventing overwrite. |
| **Graceful indicator ownership** | `withLoopIndicator` creates local `indicator`; finally clears timer and deletes only if `loopIndicators.get(sessionId) === indicator` (`index.ts` ~126–138). `session_shutdown` clears timer and deletes independently (`index.ts` ~803–809). Non-TUI guarded by `if (ctx.mode !== "tui") return run();` (`index.ts` ~113). |
| **Non-TUI animation test** | `tests/extension.test.mjs` asserts `harness.statuses.every(([, status]) => !/looping/.test(status ?? ""), true, "a non-TUI session never shows the animated status")` (~267). Animation test for TUI asserts multi-frame `looping` status and restoration after cancellation/finish (~122, ~285). `docs/autonomous-loop.md` explicitly states “Non-TUI sessions do not show the animation.” |
| **Docs** | `docs/autonomous-loop.md` updated: `stop` behavior (matches/omitted/mismatch, session slot retention, unwinding message); `resume`/`confirm` note; TUI animation and session ownership paragraph; session shutdown clears animation; non-TUI clause; command detached behavior updated. |

---

### Prior findings — resolved?

All targeted items from the prior review are addressed in this diff **except the intentionally unfixed lease-test**. No new issues introduced by the diff:

- Status restoration / arbitration / ownership: implemented and covered by new tests.
- Stop arbitration / mismatch / no-campaign stop: implemented and covered.
- Indicator lifecycle / non-TUI guard / shutdown cleanup: implemented and covered (test + code).
- Docs: synchronized with behavior.

**Lease-test / exclusive-create fallback:** The prior review hypothesized a partial lease could be exposed by the exclusive-create fallback but did not reproduce it. The current diff does not touch lease/budget creation logic (no change in `budget.ts` or lease paths). The task explicitly keeps it unfixed because no cause was reproduced. Nothing new triggers it; `DREAM_RSI_HELDOUT=1` run passes 316/316, confirming it is held out, not broken by this change.

---

### Remaining issues

**None actionable remain.** The diff closes all previously reported lifecycle/status/ownership/findings points. The only outstanding item is the **intentional lease-test holdout** (no reproduced cause, not modified, excluded by `DREAM_RSI_HELDOUT=1`).

**Severity:** N/A — no P0/P1/P2 fixes required beyond the already-resolved set.

---

### Notes / gaps to flag (not blockers)

- I did not personally execute `node --test`, `npm run typecheck`, or `npm test`; I reviewed source, diff, and reported results only.
- The base `npm test` 3 skips = held-out/lease-test cases; `DREAM_RSI_HELDOUT=1` confirms zero other skips.
- No files modified since validation; diff is exactly the 3-file change above.