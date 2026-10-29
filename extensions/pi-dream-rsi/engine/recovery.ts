export type RecoveryCategory = "configuration" | "approval" | "environment" | "instrument" | "correctness" | "budget" | "commit" | "cancelled" | "search-exhausted" | "continuation" | "plateau" | "completed";

export function recovery(category: RecoveryCategory) {
  const guidance: Record<RecoveryCategory, string> = {
    configuration: "Correct the proposed settings or declare the missing workload. Review any change to scope, gates, metric or permissions before execution.",
    approval: "Review the complete proposal and obtain the missing approval. Consent, setup authorization and contract replacement are distinct.",
    environment: "Restore the approved interpreter, installed dependencies or agent access. Do not install, change credentials or start another paid run without authorization.",
    instrument: "Inspect the pinned workload, baseline and oracle evidence. Repair only approved setup files; a changed instrument needs review and qualification again.",
    correctness: "Inspect the failed gate and preserve its assertions and reference inputs. Correct implementation within approved scope, or request a revised boundary.",
    budget: "The durable allowance cannot be renewed by restarting or replacing a contract. Inspect remaining budget and saved confirmation before any continuation.",
    commit: "Inspect git status and the verified patch evidence. Do not commit unverified or unrelated files; resolve any preserved staging or working-tree conflict manually.",
    cancelled: "Inspect status. Resume an interrupted campaign or saved confirmation only when requested; a cancelled preparation needs a new user command.",
    "search-exhausted": "No eligible verified lever remains. Inspect recorded evidence; do not fabricate a metric or repeat an unchanged attempt.",
    continuation: "Inspect status and continue the saved confirmation with action=confirm, or resume an interrupted campaign with action=resume. Reuse saved evidence and remaining budget; do not start another search.",
    plateau: "The approved no-win plateau was reached. Review the attempt timeline and verified evidence before explicitly changing the approved goal or plateau policy; budget and counters are not reset.",
    completed: "No instrument repair is indicated. Review the verified working-tree changes and recorded evidence.",
  };
  return { category, next_step: guidance[category], automatic_retries: 0 };
}

/** Diagnostic classification only. It never changes gates, permissions, results or retry policy. */
export function recoveryForLoop(result: { stopCode: string; stopReason: string; preflight: { checks: Array<{ name: string; status: string }> } }) {
  if (result.stopCode === "budget-exhausted" || result.stopCode === "budget" || result.stopCode === "deadline") return recovery("budget");
  if (result.stopCode === "completed" || result.stopCode === "confirmation-complete") return recovery("completed");
  if (result.stopCode === "confirmation-pending" || result.stopCode === "paused") return recovery("continuation");
  if (result.stopCode === "post-apply-failure") return recovery("correctness");
  if (result.stopCode === "commit-failure") return recovery("commit");
  if (result.stopCode === "cancelled") return recovery("cancelled");
  if (result.stopCode === "consent-required" || result.stopCode === "not-approved") return recovery("approval");
  if (result.stopCode === "plateau") return recovery("plateau");
  if (result.stopCode === "no-verifiable-lever") return recovery("search-exhausted");
  const blocked = result.preflight.checks.find(check => check.status === "blocked")?.name;
  if (blocked === "git") return recovery("commit");
  if (blocked === "budget") return recovery("budget");
  const reason = result.stopReason;
  if (/ENOENT|spawn|not installed|not found|import.error|dependencies.*import|liveness|provider|credential|quota|authentication/i.test(reason)) return recovery("environment");
  if (blocked === "scope" || /no benchmark or custom workload|no declared command|no.*evaluator.*supplied|outside.*scope|auto.commit.*clean working tree|not inside a Git working tree/i.test(reason)) return recovery("configuration");
  if (/approval|replace.contract|saved contract/i.test(reason)) return recovery("approval");
  if (/oracle|sensitivity|baseline|qualification|inert|instrument/i.test(reason)) return recovery("instrument");
  if (blocked === "gates" || /correctness|gate.*fail|digest.*mismatch/i.test(reason)) return recovery("correctness");
  return recovery("instrument");
}
