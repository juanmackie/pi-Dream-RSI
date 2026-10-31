# Continuous magnitude: plan review and Phase 0/1 slice

This document records the review of the continuous magnitude proposal and the
smaller slice that this repository now implements. It names what changed, what
did not change, and what stays deferred.

## Decision

Implement the Phase 0/1 core only:

- a durable, versioned project card;
- a conservative magnitude estimator;
- magnitude-aware lever ordering;
- a thin `evolve` command that reuses the existing bounded loop.

Do not implement a separate continuous controller, a scheduler, an auto-PR
path, or a new commit policy engine in this slice. The classic `/dream-rsi
loop` path stays the primary surface and keeps its behavior.

## What the slice adds

### Project card

`engine/fingerprint.ts` builds `.dream-rsi/project-card.json` with one bounded,
read-only scan. The card records:

- languages by file count and share;
- package managers;
- declared test runners and benchmark commands;
- CI commands (recorded, never run);
- entry points;
- import hotspots and inbound-import counts;
- cheap complexity signals (nested loops, linear scans in loops, blocking I/O
  in loops, serial awaits, branch-heavy files, large files, god files);
- dependency declarations, unpinned ranges, pre-1.0 ranges, and duplicate
  majors;
- architecture smells (import cycles, god files, deep paths, unreachable
  modules);
- ranked magnitude candidates.

The card is advisory. It runs no project command, qualifies no instrument, and
grants no edit scope. Its digest excludes `generatedAt`, so an unchanged tree
keeps one identity. A corrupt card, or a card whose body no longer matches its
digest, is treated as absent.

The scan is bounded by file count, total bytes, text size, read bytes, depth,
and a skip list. Secret-shaped paths are never read. The first version
deliberately uses cheap static signals only; it does not profile, call a model,
or parse a full language AST.

### Magnitude estimator

`engine/magnitude.ts` maps structural evidence to a campaign type and a
best-case multiplier:

| Signal | Campaign type | Best case | Confidence |
| --- | --- | --- | --- |
| Nested loops | `algorithmic` | 6x (8x with a linear scan in the loop) | 0.35 |
| Linear scan in a loop | `algorithmic` | 3.5x | 0.45 |
| Blocking I/O in a loop or serial awaits | `systemic` | 2.2x–3.5x | 0.5 |
| Dependency major lag | `dependency` | 1.5x–2.5x | 0.4 |
| God file, large file, or branch-heavy code | `structural` | 1.4x | 0.55 |
| No signal | `local-hill` | 1.15x | 0.7 |

The ordering utility is `log2(max(1, multiplier)) * clamp(confidence, 0, 1)`.
A large uncertain bet can outrank a small confident one. That is the product
decision. The multiplier is not a promise, and the estimator stays coarse on
purpose.

`estimateScopeMagnitude` merges the files in one lever's editable scope. The
best estimate wins. Repeated evidence of the same campaign type adds at most
0.1 confidence, so a repeated pattern cannot look like a certainty.

### Magnitude-aware ranking

`buildReconInventory` multiplies each lever's existing score by
`max(0.05, magnitudeUtility(...))`. The factor changes order only. It does not
change:

- the base score formula;
- metric qualification;
- gates;
- review;
- the independent post-apply check;
- promotion thresholds;
- budgets or stop rules.

A lever from a recon result without a project directory (an older record or a
caller that does not supply one) keeps its original score and has no
`magnitude` field. The field is optional in `LeverProposal`.

### Thin `evolve` command

`/dream-rsi evolve` is `/dream-rsi loop` with `continuous: true`. It uses the
same consent dialog, the same preparation flow, the same durable budget, the
same plateau and pacing rules, and the same stop/resume commands. The
difference is that the existing opt-in continuation is on.

`campaignType` and `strategy` are optional fields on campaign records and
status. They are persisted when present and passed to the discovery prompt as
search ambition. They steer the candidate prompt; they are not gates.

## Safety invariants

| Invariant | How this slice keeps it |
| --- | --- |
| Trusted-local consent | `evolve` uses the same explicit consent path as `loop`. |
| Fail-closed instrument qualification | The card and estimator never qualify an instrument. |
| Isolated experiments | No experiment path changed. |
| Conjunctive gates and independent post-apply verification | No gate or verification path changed. |
| Data-only dream step | The estimator reads static files; it does not execute agent code as policy. |
| Immutable durable budgets | `evolve` adds no budget renewal. It sets only the existing `continuous` flag. |
| Single-command stop, pause, revert | `stop`, `resume`, and Git recovery are unchanged. |
| Auto-commit opt-in and policy-driven | No default changed. `evolve` does not enable auto-commit. |

## Review of the proposal

### What the proposal gets right

- It keeps the safety model. The ambitious surface is additive, not a
  replacement for the bounded loop.
- It separates discovery from promotion. A larger search space does not need a
  weaker gate.
- It treats the project card as durable evidence. A later run can compare its
  belief with the tree instead of re-deriving everything.
- It asks for honest magnitude reporting. A best-case multiplier with a
  confidence value is more honest than a single predicted number.

### Risks and limits

- **Static signals are weak evidence.** Nested loops do not prove a gain. A
  hot path may be bounded by I/O, allocation, or a dependency. The estimator
  must stay an ordering hint.
- **Magnitude can crowd out small wins.** A high-multiplier, low-confidence bet
  can consume a campaign that a small, reliable win would have used. The
  current factor is deliberately bounded and the existing budget and plateau
  rules still stop a run.
- **A project card can go stale.** The digest detects tampering, not a changed
  tree after the card was written. The loop rebuilds the card on each recon;
  `status` reads the saved card as evidence, not as the current tree.
- **`evolve` is not a daemon.** It is a bounded loop with continuation on. A
  finished process does not restart itself. A later explicit resume is still
  required after a day or session boundary.
- **No auto-PR path.** The existing commit policy stays local and opt-in. A
  remote or PR workflow needs its own approval and failure model.

### Deferred work

- A long-running controller or daemon with periodic re-assessment.
- Automatic goal synthesis from the card and history.
- Multi-campaign orchestration with a shared queue.
- Plateau escalation from `local-hill` to a higher campaign type.
- Held-out and stress variants for high-stakes magnitude claims.
- A configurable auto-commit policy engine and PR mode.
- Cumulative magnitude reporting and a magnitude challenge suite.

These items need their own design and verification. They are not implied by
the presence of `evolve`.

## Evidence

- `tests/fingerprint.test.mjs` covers the bounded scan, digest stability,
  tamper rejection, scope magnitude, and summary bounds.
- `tests/magnitude.test.mjs` covers the estimator rules, utility ordering,
  scope merging, and labels.
- `tests/recon.test.mjs` covers deterministic magnitude ordering and a lever
  without a magnitude estimate.
- `tests/campaign-runtime.test.mjs` covers a campaign record without
  `campaignType` or `strategy`.
- `npm test`: 478 tests, 475 passed, 0 failed, 3 skipped (the held-out tests
  require `DREAM_RSI_HELDOUT=1`).
- `npm run typecheck`: passed.
- `node --test tests/package-contents.test.mjs`: 1 passed; the new user-facing
  document is included in the npm package.

## Open questions

- Should the default magnitude factor weight confidence more strongly after
  the first real-world comparison?
- Should a project card be refreshed on a timer, or only on recon and explicit
  status?
- Which campaign type should a plateau escalate to first: `structural` or
  `algorithmic`?
- Should `evolve` require an explicit duration or campaign cap in addition to
  the durable budget?
