/** Short synchronous allocator transactions and durable phase ownership. */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { readJson, type PhaseOwner } from "./world.ts";
export function pidIsAlive(pid: number): boolean {
  try { if (!Number.isInteger(pid) || pid <= 0) return false; process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
interface Lock extends PhaseOwner { token: string }
export function allocator<T>(root: string, fn: () => T): T {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, ".allocator.lock");
  const token = randomUUID();
  for (let attempt = 0; ; attempt++) {
    try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: "wx" }); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const old = readJson<{ pid: number }>(file);
      if (old && !pidIsAlive(old.pid) && attempt < 2) {
        // Serialize stale-lock removal so two reclaimers cannot unlink a new owner's lock.
        const reclaim = `${file}.reclaim`;
        let acquired = false;
        try {
          fs.writeFileSync(reclaim, String(process.pid), { flag: "wx" }); acquired = true;
          const current = readJson<{ pid: number }>(file);
          if (current && !pidIsAlive(current.pid)) fs.rmSync(file, { force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        } finally { if (acquired) fs.rmSync(reclaim, { force: true }); }
        continue;
      }
      throw new Error("another session is allocating Dream-RSI work; retry shortly");
    }
  }
  try { return fn(); } finally { if (readJson<{token: string}>(file)?.token === token) fs.rmSync(file, { force: true }); }
}
const held = new Set<string>();
export function acquirePhase(root: string, name: string, owner?: PhaseOwner): () => void {
  const file = path.join(root, `${name}.lock`);
  const mine: Lock = { session_id: owner?.session_id ?? "engine", pid: process.pid, claimed_at: new Date().toISOString(), token: randomUUID() };
  // Must be called within allocator when coordinating across phases.
  const old = readJson<Lock>(file);
  if (fs.existsSync(file)) {
    const stoppedHere = old?.pid === process.pid && old?.session_id === mine.session_id && !held.has(file);
    if (!old || held.has(file) || (!stoppedHere && pidIsAlive(old.pid))) throw new Error(`${name} is owned by another active run`);
    fs.rmSync(file, { force: true });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(mine), { flag: "wx" }); held.add(file);
  return () => { held.delete(file); if (readJson<Lock>(file)?.token === mine.token) fs.rmSync(file, { force: true }); };
}
export function dreamIsActive(root: string): boolean {
  const file = path.join(root, "dream.lock");
  if (!fs.existsSync(file)) return false;
  const old = readJson<Lock>(file); return !old || pidIsAlive(old.pid);
}

export function phaseIsActive(root: string, name: string): boolean {
  const file = path.join(root, `${name}.lock`);
  if (held.has(file)) return true;
  const old = readJson<Lock>(file);
  return fs.existsSync(file) && (!old || pidIsAlive(old.pid));
}
