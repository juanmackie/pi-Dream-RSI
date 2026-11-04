# On-Track Assessment Report: pi-dream-rsi

## NORTH STAR (locked)
>A researcher can explore improved exploration policies for AI systems
>and see verified replay-science improvements in policy method changes
>when the Dream-RSI loop runs verified improvement cycles.

## SETTLED BRANCHES

### 1. Scope (Q3) → both in parallel
Running improvement loops AND improving loop mechanisms simultaneously.
The project will continue its current campaign of running verified
improvement loops while also pursuing magnitude-aware continuous evolution,
contrastive search meta-loop, and policy verification work.

### 2. Proof (Q4) → measurable score improvement in benchmark
Replay-science score change counts as verified improvement, not just
passing the policy-gate.mjs gate. Both are required for full verification.

### 3. Constraints (Q5) → keep caps as-is, opt into continuous mode
Durable caps remain at 6 campaigns, 72 agent starts, 200 evaluator runs,
120 minutes. Continuous mode with plateau-bounded continuation is opted into.

### 4. Trajectory (Q6) → continue with current configuration
The Dream-RSI loop will proceed with the settled settings.

## KEEP
- Running verified improvement loops with durable budgets
- Measurable score improvement as proof standard
- Durable caps (6 campaigns, 72 agent starts, 200 evaluator runs, 120 min)
- Continuous mode with plateau-bounded continuation
- Both parallel directions: running loops + improving mechanisms

## STOP
- Pivoting to a different goal
- Decreasing caps
- Moving away from the stated North Star

## OUT OF SCOPE
- Focusing solely on loop mechanism improvements at the expense of running loops
- Abandoning the durable budget framework

## FIRST PROOF (riskiest assumption, cheapest test)
Run one full Dream-RSI cycle with the current configuration and verify
that measurable score improvement occurs in the benchmark. Pass/fail:
Score change detected AND verified by independent post-apply check.

## TASKS (1–3, each traces to North Star)

### Task 1: Run one full Dream-RSI cycle with current config and verify
measurable score improvement in the benchmark.
- **Prerequisite**: Current project setup with policy-gate.mjs and benchmark.
- **Pass/Fail**: Score change detected AND verified by independent post-apply check.

### Task 2: Implement continuous mode configuration and verify that
plateau-bounded continuation works across multiple campaigns without
exceeding durable caps.
- **Prerequisite**: Configure .dream-rsi/ for continuous mode.
- **Pass/Fail**: Multiple campaigns run successfully within caps.

### Task 3: Document the scope configuration where improvement loops and
loop mechanism improvements run in parallel, and verify that both
directions serve the North Star.
- **Prerequisite**: Review of current .dream-rsi configuration and campaign states.
- **Pass/Fail**: Documentation reflects both parallel directions and they're
  verified to serve the North Star.

## CONFIDENCE & VERIFIED

### PROVEN
- North Star locked, 4 branches settled with explicit yes/choices,
  durable budget framework exists and is operational.

### UNVERIFIED
- Whether running improvement loops and improving mechanisms
  in parallel will actually produce measurable score improvements in the
  benchmark.
- Whether continuous mode plateau-bounded continuation will
  function correctly across the full campaign budget.
- Whether the documented scope configuration accurately serves the North Star
  in practice.

---
**Report generated**: On-track skill assessment following ASD-STE100 Simplified Technical English
**All phases completed**: Phase 0 (calibrate), Phase 1 (investigate), Phase 2 (North Star pinning), Phase 3–4 (branch visiting), Phase 5 (route drafting), Phase 6 (acceptance waiting)