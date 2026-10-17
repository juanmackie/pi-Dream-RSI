import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { appendLedgerRecord, readLedger, ledgerHealth, ledgerDigest, patchFingerprint } = await import(new URL("../extensions/pi-dream-rsi/engine/ledger.ts", import.meta.url));

test("ledger appends sanitized v1 facts and summarizes cross-campaign health", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-ledger-"));
  const file = path.join(dir, "history", "ledger.jsonl");
  try {
    const fingerprint = patchFingerprint("diff --git a/x b/x\n");
    appendLedgerRecord(file, { kind: "attempt", campaignId: "c1", stage: "attempt", agent: "agent-a", outcome: "timeout", ...fingerprint, editCount: 0, verifierRead: true, usage: { input: 10, output: 2 }, facts: { mode: "live", direction: "north", private: "sk-live-do-not-store" } }, new Date("2026-10-16T00:00:00Z"));
    appendLedgerRecord(file, { kind: "confirm", campaignId: "c1", stage: "confirm", agent: "agent-a", outcome: "success", ...fingerprint }, new Date("2026-10-16T00:01:00Z"));
    const { entries, diagnostics } = readLedger(file);
    assert.deepEqual(diagnostics, []);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].v, 1);
    assert.equal(entries[0].patchHash, fingerprint.patchHash);
    assert.equal(entries[0].facts.private, undefined, "secret-bearing arbitrary text is dropped");
    const health = ledgerHealth(entries);
    assert.equal(health.timeoutCount, 1);
    assert.equal(health.noEditCount, 1);
    assert.equal(health.duplicatePatches, 0, "evidence for the same patch is not a repeated proposal");
    assert.equal(health.wins, 0, "confirmation does not imply the patch was applied");
    const digest = ledgerDigest(entries);
    assert.ok(digest.length <= 1500);
    assert.match(digest, /timeouts/);
    assert.doesNotMatch(digest, /sk-live|north|ledger\.jsonl/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("ledger reader skips incomplete records and caps the digest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-ledger-bad-"));
  const file = path.join(dir, "ledger.jsonl");
  try {
    fs.writeFileSync(file, '{"v":1,"t":"now","entryId":"x","kind":"attempt"}\nnot json\n');
    const result = readLedger(file);
    assert.equal(result.entries.length, 1);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(ledgerDigest(result.entries, 8).length, 8);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
