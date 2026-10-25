# ADR 0003: The gate set is conjunctive, and sensitivity is a property of the set

Status: accepted

## Context

A candidate is accepted only when every required correctness gate passes. Gates
differ in reach: a structural gate (a linter, a smoke command, a schema check)
can pass code that does not work, so it cannot show that a behavioral defect is
detectable. If every gate had to detect every defect, a repository could not
qualify an instrument with a real test suite plus a structural check, and a
weak structural gate would be reported as if it were the oracle.

## Decision

1. Promotion is conjunctive. Every required gate must pass on the candidate
   before it is promoted. A gate is not exempted because another gate is
   stronger.
2. Qualification sensitivity is a property of the gate set, not of each gate.
   The set is sensitive when at least one gate passes on the pristine target and
   rejects the inert implementation of the editable scope.
3. A structural gate that accepts inert code is diagnostic evidence, not an
   automatic refusal, while point 2 holds. The receipt records that the gate
   accepted inert code, so the reader can see the gap.
4. A gate that already fails on the pristine target cannot establish
   sensitivity. Qualification refuses instead of using the failure as proof.
5. Controls never disable their own verifier. A control whose edited files
   overlap verifier inputs, protected assets, or unsafe paths is refused before
   evaluator spend. The receipt records the exact files each control mutated.

## Consequences

- A repository keeps cheap structural gates without pretending they observe
  behavior.
- A reader of a qualification receipt must check three things before trusting a
  gate set: which gates are required, which gate rejected the inert
  implementation, and which gates accepted it.
- Adding a gate can only make promotion stricter; it can also make sensitivity
  pass, so the recorded rejecting gate matters.
