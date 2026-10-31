# Dream-RSI

Dream-RSI runs measured experiments within an approved project boundary. These terms distinguish permission to execute from evidence that an improvement is valid.

## Language

**Run contract**:
The agreed objective, metric, correctness requirements, editable scope, execution permissions, and budget for an improvement loop.
_Avoid_: Task prompt, consent flag

**Editable scope**:
The files that approved candidates or setup work may change. Existing verification dependencies can be read or run without belonging to editable scope.
_Avoid_: Read allowlist, verifier access list

**Execution consent**:
The operator's acceptance that project code runs on the host with the operator's access.
_Avoid_: Campaign readiness, improvement approval

**Contract replacement**:
A separately approved change to the saved run boundary that retains prior spend and the existing budget limits.
_Avoid_: Budget reset, automatic reapproval

**Measurement harness**:
The fixed workload, measurement procedure, and correctness oracle used to decide whether a candidate improves the stated objective.
_Avoid_: Arbitrary score, success claim

**Instrument qualification**:
Evidence that a measurement is reproducible, responds to relevant changes, and rejects missing or incorrect behavior before experiments use it.
_Avoid_: File creation success, execution consent

**Project card**:
A durable, advisory snapshot of a project's languages, package managers, declared test and benchmark commands, hotspots, dependency signals, and magnitude candidates. It runs no project command and grants no edit scope.
_Avoid_: Approved plan, evaluator, readiness proof

**Magnitude estimate**:
A coarse structural estimate of the plausible gain size and the confidence that it is reachable. It orders search; it does not decide promotion.
_Avoid_: Predicted gain, verified improvement, promotion threshold

**Continuous magnitude mode**:
The guarded loop with continuous continuation switched on (`/dream-rsi evolve`). It uses the same consent, budget, gates, verification, and stop rules as `/dream-rsi loop`.
_Avoid_: Daemon, unbounded loop, auto-PR mode
