import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { allocator } from "./ownership.ts";
import { readLedger } from "./ledger.ts";
import { emptyMemory, isCurrentExperiment, recordCampaignOutcome, type ExperimentProvenance, type LoopMemory, type LoopMemoryRecord } from "./search.ts";

const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_LESSONS = 20_000;
const OUTCOMES = new Set(["win", "no-win", "error", "rejected"]);

export interface LessonProfile {
  id: string;
  benchmarkId: string;
  executorId: string;
  mode: "legacy" | "rsi";
  budgetId: string;
  seedId: string | null;
}

export interface LessonEvidence {
  campaignId: string;
  ledgerHash: string;
  ledgerEntries: number;
}

export interface Lesson {
  version: 1;
  sequence: number;
  lessonId: string;
  profileId: string;
  record: LoopMemoryRecord;
  evidence: LessonEvidence;
  previousHash: string;
  recordHash: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Hash the executor and budget so credentials and raw command arguments are not written to the lesson store. */
export function lessonProfile(input: {
  benchmark: string;
  executor: unknown;
  mode: "legacy" | "rsi";
  budget: unknown;
  seed: string | null;
}): LessonProfile {
  const profile = {
    benchmarkId: hash(input.benchmark),
    executorId: hash(stableJson(input.executor)),
    mode: input.mode,
    budgetId: hash(stableJson(input.budget)),
    seedId: input.seed === null ? null : hash(input.seed),
  };
  return { ...profile, id: hash(stableJson(profile)) };
}

function lessonFile(root: string, profile: LessonProfile): string {
  if (!HASH.test(profile.id) || !HASH.test(profile.benchmarkId) || !HASH.test(profile.executorId) || !HASH.test(profile.budgetId)
    || !(profile.seedId === null || HASH.test(profile.seedId)) || (profile.mode !== "legacy" && profile.mode !== "rsi")) {
    throw new Error("invalid lesson library profile");
  }
  return path.join(root, `${profile.id}.jsonl`);
}

function evidenceFor(value: unknown): LessonEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid lesson evidence");
  const item = value as Partial<LessonEvidence>;
  if (typeof item.campaignId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(item.campaignId)
    || typeof item.ledgerHash !== "string" || !HASH.test(item.ledgerHash)
    || !Number.isSafeInteger(item.ledgerEntries) || (item.ledgerEntries ?? 0) < 1) {
    throw new Error("invalid lesson evidence");
  }
  return { campaignId: item.campaignId, ledgerHash: item.ledgerHash, ledgerEntries: item.ledgerEntries! };
}

function cleanRecord(value: LoopMemoryRecord): LoopMemoryRecord {
  if (!value || value.kind !== "campaign" || typeof value.leverId !== "string" || !value.leverId || value.leverId.length > 200
    || !OUTCOMES.has(value.outcome) || !Number.isSafeInteger(value.evaluatorRuns) || value.evaluatorRuns < 0
    || !Number.isSafeInteger(value.agentStarts) || value.agentStarts < 0 || !Number.isSafeInteger(value.wallMs) || value.wallMs < 0
    || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))
    || (value.verifiedGain !== undefined && (!Number.isFinite(value.verifiedGain) || value.verifiedGain < 0))) {
    throw new Error("invalid lesson outcome");
  }
  let provenance: ExperimentProvenance | undefined;
  if (value.provenance !== undefined) {
    const allowed = new Set(["contractId", "evaluatorId", "baselineFingerprint", "mechanism", "strategyClass", "parentCampaign"]);
    const entries = Object.entries(value.provenance);
    if (entries.some(([key, item]) => !allowed.has(key) || typeof item !== "string" || item.length > 200)) throw new Error("invalid lesson provenance");
    provenance = Object.fromEntries(entries) as ExperimentProvenance;
  }
  return {
    kind: "campaign", leverId: value.leverId, outcome: value.outcome,
    evaluatorRuns: value.evaluatorRuns, agentStarts: value.agentStarts, wallMs: value.wallMs, at: value.at,
    ...(value.verifiedGain === undefined ? {} : { verifiedGain: value.verifiedGain }),
    ...(provenance ? { provenance } : {}),
  };
}

function verifyLedgerEvidence(root: string, evidence: LessonEvidence): void {
  const baseRoot = path.resolve(root, "..");
  const ledgerFile = path.join(baseRoot, "campaigns", evidence.campaignId, "history", "ledger.jsonl");
  const ledger = readLedger(ledgerFile);
  if (ledger.diagnostics.length || ledger.fileHash !== evidence.ledgerHash || ledger.entries.length !== evidence.ledgerEntries
    || !ledger.entries.some((entry) => entry.campaignId === evidence.campaignId)) {
    throw new Error("lesson evidence does not match its retained campaign ledger");
  }
}

function payload(lesson: Omit<Lesson, "recordHash">): string { return stableJson(lesson); }

/** Read and verify one append-only library. Any partial or forked history fails closed. */
export function readLessons(root: string, profile: LessonProfile): Lesson[] {
  const file = lessonFile(root, profile);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("lesson history cannot be inspected");
  }
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("lesson history is unavailable or exceeds its size limit");
  const text = fs.readFileSync(file, "utf8");
  if (text && !text.endsWith("\n")) throw new Error("corrupted lesson history: incomplete final record");
  const lines = text.split("\n").filter(Boolean);
  if (lines.length > MAX_LESSONS) throw new Error("lesson history exceeds its record limit");
  const lessons: Lesson[] = [];
  let previousHash = "0".repeat(64);
  const campaigns = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    try {
      const parsed: unknown = JSON.parse(lines[index]);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      const item = parsed as Lesson;
      const record = cleanRecord(item.record);
      const evidence = evidenceFor(item.evidence);
      verifyLedgerEvidence(root, evidence);
      if (item.version !== 1 || item.sequence !== index + 1 || typeof item.lessonId !== "string" || !item.lessonId
        || item.profileId !== profile.id || item.previousHash !== previousHash || typeof item.recordHash !== "string" || !HASH.test(item.recordHash)
        || campaigns.has(evidence.campaignId)) throw new Error();
      const { recordHash, ...unsigned } = item;
      if (recordHash !== hash(`${previousHash}\n${payload({ ...unsigned, record, evidence })}`)) throw new Error();
      const lesson: Lesson = { ...unsigned, record, evidence, recordHash };
      lessons.push(lesson);
      campaigns.add(evidence.campaignId);
      previousHash = recordHash;
    } catch {
      throw new Error(`corrupted lesson history at record ${index + 1}; refusing to continue`);
    }
  }
  return lessons;
}

/** Append exactly once per campaign, fsyncing the record before returning. */
export function appendLesson(root: string, profile: LessonProfile, record: LoopMemoryRecord, evidenceValue: LessonEvidence): Lesson {
  const file = lessonFile(root, profile);
  const clean = cleanRecord(record);
  const evidence = evidenceFor(evidenceValue);
  return allocator(root, () => {
    verifyLedgerEvidence(root, evidence);
    const prior = readLessons(root, profile);
    const existing = prior.find((lesson) => lesson.evidence.campaignId === evidence.campaignId);
    if (existing) {
      if (existing.evidence.ledgerHash === evidence.ledgerHash && existing.evidence.ledgerEntries === evidence.ledgerEntries
        && stableJson(existing.record) === stableJson(clean)) return existing;
      throw new Error(`conflicting lesson for campaign ${evidence.campaignId} already exists`);
    }
    if (prior.length >= MAX_LESSONS) throw new Error("lesson library is full");
    const previousHash = prior.at(-1)?.recordHash ?? "0".repeat(64);
    const unsigned: Omit<Lesson, "recordHash"> = {
      version: 1, sequence: prior.length + 1, lessonId: randomUUID(), profileId: profile.id,
      record: clean, evidence, previousHash,
    };
    const lesson: Lesson = { ...unsigned, recordHash: hash(`${previousHash}\n${payload(unsigned)}`) };
    const line = `${JSON.stringify(lesson)}\n`;
    const currentBytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (currentBytes + Buffer.byteLength(line, "utf8") > MAX_BYTES) throw new Error("lesson library reached its size limit");
    fs.mkdirSync(root, { recursive: true });
    const fd = fs.openSync(file, "a");
    try { fs.writeFileSync(fd, line, "utf8"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    return lesson;
  });
}

/** Replay only events strictly before `beforeSequence` and matching the current baseline. */
export function replayLessonPrefix(
  lessons: Lesson[], beforeSequence = Number.POSITIVE_INFINITY, current: { baselineFingerprint?: string } = {},
): LoopMemory {
  if (!(beforeSequence === Number.POSITIVE_INFINITY || (Number.isSafeInteger(beforeSequence) && beforeSequence >= 1))) {
    throw new Error("lesson prefix sequence must be a positive integer");
  }
  let memory = emptyMemory();
  for (const lesson of lessons) {
    if (lesson.sequence >= beforeSequence) break;
    if (isCurrentExperiment(lesson.record, current)) memory = recordCampaignOutcome(memory, cleanRecord(lesson.record));
  }
  return memory;
}
