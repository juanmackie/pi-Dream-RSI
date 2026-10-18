import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { appendLedgerRecord, readLedger, ledgerHealth, ledgerDigest, patchFingerprint } = await import(new URL("../extensions/pi-dream-rsi/engine/ledger.ts", import.meta.url));

test("ledger appends sanitized, linked v1 facts and summarizes cross-campaign health", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-ledger-"));
  const file = path.join(dir, "history", "ledger.jsonl");
  try {
    const fingerprint = patchFingerprint("diff --git a/x b/x\n");
    appendLedgerRecord(file, { kind: "agent_start", campaignId: "c1", stage: "attempt", outcome: "reserved" }, new Date("2026-10-15T23:59:00Z"));
    appendLedgerRecord(file, { kind: "attempt", campaignId: "c1", stage: "attempt", agent: "agent-a", outcome: "timeout", ...fingerprint, editCount: 0, verifierRead: true,
      facts: { mode: "live", direction: "north", private: "sk-live-do-not-store" } }, new Date("2026-10-16T00:00:00Z"));
    appendLedgerRecord(file, { kind: "agent_result", campaignId: "c1", stage: "attempt", agentRole: "experiment", outcome: "failed",
      usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4 }, agentDurationMs: 12_000 }, new Date("2026-10-16T00:00:30Z"));
    appendLedgerRecord(file, { kind: "confirm", campaignId: "c1", stage: "confirm", agent: "agent-a", outcome: "success", ...fingerprint, evaluatorRunCount: 2, evaluatorDurationMs: 800 }, new Date("2026-10-16T00:01:00Z"));
    const { entries, diagnostics } = readLedger(file);
    assert.deepEqual(diagnostics, []);
    assert.equal(entries.length, 4);
    assert.match(entries[0].recordHash, /^[a-f0-9]{64}$/);
    assert.equal(entries[1].previousHash, entries[0].recordHash);
    assert.equal(entries[1].v, 1);
    assert.equal(entries[1].patchHash, fingerprint.patchHash);
    assert.equal(entries[1].facts.private, undefined, "secret-bearing arbitrary text is dropped");
    const health = ledgerHealth(entries);
    assert.equal(health.timeoutCount, 1);
    assert.equal(health.noEditCount, 1);
    assert.equal(health.duplicatePatches, 0, "evidence for the same patch is not a repeated proposal");
    assert.equal(health.wins, 0, "confirmation does not imply the patch was applied");
    assert.deepEqual(health.resources, {
      agentStartReservations: 1, evaluatorRuns: 2, agentDurationMs: 12_000, evaluatorDurationMs: 800,
      inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4,
    }, "token and elapsed-process resources roll up without inventing monetary pricing");
    assert.match(ledgerDigest(entries), /12000 ms agent time/);
    const digest = ledgerDigest(entries);
    assert.ok(digest.length <= 1500);
    assert.match(digest, /timeouts/);
    assert.doesNotMatch(digest, /sk-live|north|ledger\.jsonl/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("ledger detects edits in a chained record and refuses further appends", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-ledger-tamper-"));
  const file = path.join(dir, "ledger.jsonl");
  try {
    appendLedgerRecord(file, { kind: "attempt", outcome: "timeout" }, new Date("2026-10-16T00:00:00Z"));
    appendLedgerRecord(file, { kind: "confirm", outcome: "success" }, new Date("2026-10-16T00:01:00Z"));
    const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
    const second = JSON.parse(lines[1]);
    second.outcome = "forged-success";
    lines[1] = JSON.stringify(second);
    fs.writeFileSync(file, `${lines.join("\n")}\n`);

    const result = readLedger(file);
    assert.equal(result.entries.length, 0, "no records are trusted after the chain fails");
    assert.match(result.diagnostics.join(" "), /hash chain verification failed/);
    assert.throws(() => appendLedgerRecord(file, { kind: "apply", outcome: "success" }), /invalid experiment ledger/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("ledger appends to legacy tails and CRLF records", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-ledger-no-newline-"));
  const file = path.join(dir, "history", "ledger.jsonl");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ v: 1, t: "2026-10-15T00:00:00Z", entryId: "legacy", kind: "attempt" }));
    appendLedgerRecord(file, { kind: "confirm", outcome: "success" });
    assert.equal(readLedger(file).entries.length, 2);

    appendLedgerRecord(file, { kind: "apply", outcome: "success" });
    const result = readLedger(file);
    assert.equal(result.entries.length, 3);
    assert.deepEqual(result.diagnostics, []);

    const crlfFile = path.join(dir, "crlf", "ledger.jsonl");
    fs.mkdirSync(path.dirname(crlfFile), { recursive: true });
    fs.writeFileSync(crlfFile, `${JSON.stringify({ v: 1, t: "2026-10-15T00:00:00Z", entryId: "legacy-crlf", kind: "attempt" })}\r\n`);
    appendLedgerRecord(crlfFile, { kind: "confirm", outcome: "success" });
    const crlf = readLedger(crlfFile);
    assert.equal(crlf.entries.length, 2);
    assert.deepEqual(crlf.diagnostics, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("ledger hashing includes prototype-named fields and rejects non-finite JSON numbers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-ledger-canonical-"));
  const file = path.join(dir, "history", "ledger.jsonl");
  try {
    appendLedgerRecord(file, { kind: "attempt", facts: { score: 1 } });
    const original = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, original.replace("{\"v\":", "{\"__proto__\":{\"forged\":true},\"v\":"));
    const prototypeEdit = readLedger(file);
    assert.equal(prototypeEdit.entries.length, 0);
    assert.match(prototypeEdit.diagnostics.join(" "), /hash chain verification failed/);

    fs.writeFileSync(file, original.replace('"score":1', '"score":1e400'));
    const nonFinite = readLedger(file);
    assert.equal(nonFinite.entries.length, 0);
    assert.match(nonFinite.diagnostics.join(" "), /unsupported data/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("ledger reader rejects incomplete history and caps the digest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-ledger-bad-"));
  const file = path.join(dir, "ledger.jsonl");
  try {
    fs.writeFileSync(file, '{"v":1,"t":"now","entryId":"x","kind":"attempt"}\nnot json\n');
    const result = readLedger(file);
    assert.equal(result.entries.length, 0, "operational readers fail closed when any corruption is present");
    assert.equal(result.diagnostics.length, 1);
    assert.equal(ledgerDigest(result.entries, 8).length, 8);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("ledger accepts a complete ledger at capacity and refuses further appends", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-ledger-capacity-"));
  const file = path.join(dir, "ledger.jsonl");
  const entries = Array.from({ length: 2000 }, (_, index) => JSON.stringify({
    v: 1,
    t: "2026-10-16T00:00:00Z",
    entryId: `entry-${index}`,
    kind: "attempt",
  })).join("\n") + "\n";
  try {
    fs.writeFileSync(file, entries);
    const full = readLedger(file);
    assert.equal(full.entries.length, 2000);
    assert.deepEqual(full.diagnostics, []);
    assert.throws(() => appendLedgerRecord(file, { kind: "attempt" }), /entry limit/);

    fs.appendFileSync(file, JSON.stringify({ v: 1, t: "2026-10-16T00:00:00Z", entryId: "entry-2000", kind: "attempt" }) + "\n");
    const overflow = readLedger(file);
    assert.equal(overflow.entries.length, 0);
    assert.match(overflow.diagnostics.join(" "), /entry limit reached/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
