/** Durable process-start reservations shared by every phase in one campaign. */
import * as fs from "node:fs";
import * as path from "node:path";
import { allocator } from "./ownership.ts";
import { writeFileAtomic } from "./world.ts";

export type CampaignProcessKind = "agent" | "evaluator";

export interface CampaignProcessLedger {
  version: 1;
  agent_limit: number;
  evaluator_limit: number;
  agent_starts: number;
  evaluator_runs: number;
  last_start: { kind: CampaignProcessKind; key: string; reserved_at: string } | null;
}

export class CampaignLimitError extends Error {
  readonly kind: CampaignProcessKind;
  readonly limit: number;
  constructor(kind: CampaignProcessKind, limit: number) {
    super(`campaign ${kind} start limit reached (${limit})`);
    this.name = "CampaignLimitError";
    this.kind = kind;
    this.limit = limit;
  }
}

export class CampaignBudget {
  readonly path: string;
  readonly root: string;
  readonly agentLimit: number;
  readonly evaluatorLimit: number;

  constructor(root: string, agentLimit: number, evaluatorLimit: number, createIfMissing = false) {
    this.root = root;
    this.agentLimit = agentLimit;
    this.evaluatorLimit = evaluatorLimit;
    this.path = path.join(root, "campaign-processes.json");
    fs.mkdirSync(root, { recursive: true });
    if (!fs.existsSync(this.path) && createIfMissing) {
      this.write({
        version: 1,
        agent_limit: agentLimit,
        evaluator_limit: evaluatorLimit,
        agent_starts: 0,
        evaluator_runs: 0,
        last_start: null,
      });
    }
    if (!fs.existsSync(this.path)) throw new Error("campaign process ledger is missing; refusing to renew its budget");
  }

  read(): CampaignProcessLedger {
    const parsed: unknown = JSON.parse(fs.readFileSync(this.path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("campaign process ledger is invalid");
    const value = parsed as Record<string, unknown>;
    if (
      value.version !== 1 ||
      value.agent_limit !== this.agentLimit ||
      value.evaluator_limit !== this.evaluatorLimit ||
      typeof value.agent_starts !== "number" || !Number.isSafeInteger(value.agent_starts) || value.agent_starts < 0 || value.agent_starts > this.agentLimit ||
      typeof value.evaluator_runs !== "number" || !Number.isSafeInteger(value.evaluator_runs) || value.evaluator_runs < 0 || value.evaluator_runs > this.evaluatorLimit ||
      !(value.last_start === null || (typeof value.last_start === "object" && value.last_start !== null && !Array.isArray(value.last_start)))
    ) throw new Error("campaign process ledger does not match the saved limits");
    const lastStart = value.last_start as Record<string, unknown> | null;
    if (lastStart && (lastStart.kind !== "agent" && lastStart.kind !== "evaluator" || typeof lastStart.key !== "string" || typeof lastStart.reserved_at !== "string")) {
      throw new Error("campaign process ledger last_start is invalid");
    }
    return {
      version: 1,
      agent_limit: this.agentLimit,
      evaluator_limit: this.evaluatorLimit,
      agent_starts: value.agent_starts,
      evaluator_runs: value.evaluator_runs,
      last_start: lastStart as CampaignProcessLedger["last_start"],
    };
  }

  reserve(kind: CampaignProcessKind, key: string): void {
    allocator(this.root, () => {
      const ledger = this.read();
      if (kind === "agent") {
        if (ledger.agent_starts >= ledger.agent_limit) throw new CampaignLimitError(kind, ledger.agent_limit);
        ledger.agent_starts += 1;
      } else {
        if (ledger.evaluator_runs >= ledger.evaluator_limit) throw new CampaignLimitError(kind, ledger.evaluator_limit);
        ledger.evaluator_runs += 1;
      }
      ledger.last_start = { kind, key, reserved_at: new Date().toISOString() };
      this.write(ledger);
    });
  }

  private write(ledger: CampaignProcessLedger): void {
    writeFileAtomic(this.path, `${JSON.stringify(ledger, null, 2)}\n`, true);
  }
}
