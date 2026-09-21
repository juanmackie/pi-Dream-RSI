# Parallel Dream-RSI loops (parallel worlds)

## Context

One online cycle today is a strictly serial phase: `dream_rsi_live` runs one episode (W attempts per
round, ≤ K1 rounds) → world `t`; `dream_rsi_dream` then replays all worlds and deploys `pi_{t+1}`.
Attempts inside a cycle are already parallel (`probe` → `Promise.all`, `engine/live.ts:358`), but
**worlds are produced one cycle at a time**, and each added world costs another full wall-clock episode.

That is the bottleneck the user wants gone: run **N online episodes of the same policy concurrently**,
each recording its own world, then let the existing offline phase replay all of them in one dream. The
method already supports this — `runDreamPhase` replays *every* recorded world (H_t) and averages Eq. 1
over them, so extra worlds need no new reward math, and the dream cost (M−1 revision agent calls) is
unchanged whether it sees 1 world or N.

Scope chosen with the user: parallel worlds of one task; implemented inside the extension; concurrency
cap defaulted by us.

## Approach

**Fan out N live episodes inside a single `dream_rsi_live` call, on N reserved iteration numbers.**

1. New tool param `loops` on `dream_rsi_live` (integer, default 1), clamped to a new task key
   `max_loops` (default **2**, validated `[1, 8]`). Clamping is reported, never silent.
2. Allocation stays disk-derived and collision-free: reservations are written **synchronously before the
   first `await`**, so two tool calls in one session cannot claim the same number. A reservation is just
   the in-flight mirror the engine already writes (`iterNNNN_current/live_cycle_manifest.json`,
   `status: "running"`), so no new artifact type and no new parser.
3. Each episode gets a pre-assigned iteration and is otherwise unchanged: `runLiveEpisode` is untouched.
   Episode `k` writes `work/rNNNN/`, `history/rNNNN_live/`, `trace_pool/iterNNNN[_current]/` — all
   already iteration-scoped, so nothing collides.
4. `Promise.allSettled`-style fan-out: one episode failing must not discard the batch. Per-world results
   are reported, the session iteration becomes the max of the batch, and leftover `running` mirrors are
   cleaned by the existing `recoverInterruptedRuns`.
5. `dream_rsi_dream` gains one guard: refuse while any world is in flight (an un-finished world would be
   silently skipped by `readTree`, making the V table and world count dishonest).
6. **Added after approval:** the agent does not have to route the parallelism through one call. Live calls no
   longer take a whole-session lock, so an agent may start several `dream_rsi_live` calls in the same turn —
   each reserves its own iteration numbers, and they all draw on the same `max_loops` budget. The session phase
   record is a list (`RunningPhase[]`), so a finishing call releases only its own claims and never marks a
   sibling's world as interrupted (hence `recoverInterruptedRuns(root, except)`). A dream phase still runs
   alone: it refuses while anything at all is in flight.

```text
pi_t --+--> episode iter0001 -> world 1
       +--> episode iter0002 -> world 2      (same policy, same baked beta, same grid)
       +--> episode iter0003 -> world 3
                      |
              dream: replay pi_0..pi_M-1 over worlds {1,2,3} -> pi_{t+1}
```

### Concurrency ceiling (recommended)

`max_loops` default **2**, hard range [1, 8]. Real fan-out = `loops × W` agent processes
(default task: 2 × 4 = 8), each also copying the seed workspace and running the scorer. The binding
constraint is the attempt model's provider-side concurrency, so the default stays conservative and the
number is configurable; the tool output prints `loops x W` so the operator sees the true fan-out before
paying for it. Documented in the skill as "raise only if the provider and the disk can take it".

## Files to modify

| File | Change |
| ---- | ------ |
| `extensions/pi-dream-rsi/state.ts` | `runningIterations(root)`, `nextIteration(root)`, `reserveIterations(root, count)` (synchronous); keep `activeRuns`/`recoverInterruptedRuns` semantics. |
| `extensions/pi-dream-rsi/index.ts` | `loops` param + schema on `dream_rsi_live`; set the phase lock **before** the first await (closes the two-parallel-tool-calls hole); fan-out, per-episode failure collection, batch report, `details.iterations`; in-flight guard in `dream_rsi_dream`; `max_loops` in `taskParams` + init mapping + budgets line + `before_agent_start` note; `/dream-rsi live [n]` width. |
| `extensions/pi-dream-rsi/engine/task.ts` | `TaskConfig.max_loops`, `defaultTask` default 2, `validateTask` range `[1, 8]`. |
| `extensions/pi-dream-rsi/engine/live.ts` | Unchanged (only an optional `reserved?: boolean` field on `LiveCycleManifest` if the reservation needs to be distinguishable). |
| `extensions/pi-dream-rsi/engine/world.ts` | `runningIterations` helper reads the existing `_current` manifests; no layout change. |
| `skills/dream-rsi/SKILL.md` | Tool table (`loops` / `max_loops`), "The loop" section: batched worlds, one dream per batch, the trend caveat below. |
| `skills/dream-rsi-create/SKILL.md` | Budget row: add `max_loops` with the `loops × W` rule and the default 2. |
| `README.md` | "Attempts can run in parallel" bullet + the cost shape (`loops × W` per live call, dream cost unchanged). |
| `tests/live-dream.test.mjs`, `tests/extension.test.mjs` | New coverage below. |

## Reuse

- `writeCurrentManifest` / `iterationDir(..., true)` (`engine/world.ts:213`) — the in-flight mirror *is*
  the reservation.
- `activeRuns` / `recoverInterruptedRuns` (`state.ts:38`, `state.ts:63`) — in-flight detection and
  crash cleanup; nothing new.
- `latestIteration`, `latestBest` (`index.ts:1009`, `index.ts:988`) — disk-derived numbering; add
  `nextIteration` beside them rather than changing them.
- `iterationReport`, `reportImprovements`/`rankCandidates` (`state.ts:129`, `engine/candidates.ts`) —
  ranking already spans all worlds, so the batch report is a loop over these.
- `interpretEvaluation` / per-attempt failure handling (`engine/live.ts`) — the pattern the batch's
  per-episode error handling copies.
- Test fixtures: `makeProject`, `mockPi`, `deployShippedPolicy`, `agent-ok.mjs` (`tests/fixtures.mjs`).

## Steps

- [x] `task.ts`: add `max_loops` (default 2, validate [1, 8]).
- [x] `world.ts`/`state.ts`: `runningIterations(root)` scanning `iterNNNN_current` manifests with
      `status: "running"`; `nextIteration(root) = max(latestIteration, max running) + 1`;
      `reserveIterations(root, count)` writing a minimal running manifest per number (synchronous).
- [x] `index.ts` `dream_rsi_live`: parse/clamp `loops`; acquire + record the phase lock before the first
      await; reserve the numbers; `await Promise.all` over per-episode try/catch; report each world plus a
      batch header; `details.iterations`, `details.iteration = max`, `details.loops`; update session
      iteration to the max; clean the batch's leftover `running` mirrors in `finally`.
- [x] `index.ts` `dream_rsi_dream`: refuse when `activeRuns(root).length > 0`, with a message saying
      which world is still in flight.
- [x] `index.ts`: `max_loops` in `taskParams`, the init mapping, the init/status budget lines, and the
      mode system-prompt note; `/dream-rsi live [n]` passes the width into the agent instruction;
      `/dream-rsi run` instruction mentions batched live calls.
- [x] Docs: `skills/dream-rsi/SKILL.md`, `skills/dream-rsi-create/SKILL.md`, `README.md`.
- [x] Agent-initiated parallel cycles (added after approval): overlapping live calls allowed, shared
      `max_loops` budget, `RunningPhase[]` session record, `recoverInterruptedRuns(root, except)`, agent
      guidance in the tool prompts, skill and system prompt.
- [x] Tests, then `npm test` — 4 new tests in `tests/extension.test.mjs`, 70/70 green (stable over 3 runs).

## Verification

Automated (`npm test`, `node --test tests/*.test.mjs`, stub agents only — no LLM):

1. `dream_rsi_live` with `loops: 3` → `iter0001..iter0003` each have `tree.json` and a `complete`
   manifest, `work/r0001..r0003` are distinct, `details.iterations == [1,2,3]`, session iteration 3.
2. `loops: 99` clamps to `max_loops` and says so in the report.
3. `dream_rsi_dream` after that batch replays `worlds === 3`, still asserts `V* >= V_0`, deploys.
4. `dream_rsi_dream` refuses while `iter0002_current` is `running`.
5. `state.ts` unit: `nextIteration` skips an in-flight reserved number and does **not** permanently skip
   one that was recovered as failed.
6. Regression: `loops` omitted (default 1) behaves exactly as today in the existing suite.

Manual (optional, costs real agent time on this repo's own self-hosted task): `/dream-rsi live 2` then
`/dream-rsi status` — two worlds, one dream, `loops x W` printed as 8.

## Known limits (deliberate, documented, not built)

- **One session owns one `.dream-rsi`.** Cross-session safety is unchanged (a second pi session in the
  same project can still trip `recoverInterruptedRuns`). A PID lock file is the upgrade path if that is
  ever wanted; building a lock manager now is not justified.
- **Trend/beta evidence gets sibling-contaminated.** `crossCycleBeta` compares the last two manifests
  (`engine/dream.ts:527`); after a batch those are siblings of the same policy, so they read as
  "plateaued" rather than "improving". Accepted (a plateau keeps or lowers beta, it never invents a
  regression). Upgrade path: add a `batch` id to `LiveCycleManifest` and compare batch-level bests.
- **Baseline seeding.** `seedBaseline` still fires on `iteration === 1` only, so the floor from a first
  batch of N is the best attempt of world 1, not the batch. Identical to today for `loops = 1`; change
  only if the floor proves too weak in practice.
- **Parallelism is only as good as the provider.** If the attempt model serialises, N worlds cost the
  same wall clock as N cycles. Report the fan-out before the call so the operator decides.
