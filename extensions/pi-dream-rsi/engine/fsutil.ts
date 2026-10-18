import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameAtomic(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try { fs.renameSync(from, to); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!(code === "EPERM" || code === "EACCES" || code === "EBUSY") || attempt >= 3) throw error;
      sleepSync(5 * (attempt + 1));
    }
  }
}

export function writeFileAtomic(file: string, contents: string, durable = false): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, contents, "utf8");
    if (durable) { const fd = fs.openSync(tmp, "r+"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
    renameAtomic(tmp, file);
    if (durable && process.platform !== "win32") { const fd = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  } finally { fs.rmSync(tmp, { force: true }); }
}

export function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
  catch { return null; }
}

export function writeJson(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function ensureDreamIgnore(root: string): string {
  const file = path.join(root, ".gitignore");
  const lines = [
    "# Written by pi-dream-rsi: bulk run state stays out of git by default.",
    "# Task configuration and history remain visible; delete this file to version everything.",
    "work/",
    "runtime/",
    "",
  ].join("\n");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(file, lines, "utf8");
    return file;
  }
  const current = fs.readFileSync(file, "utf8");
  const missing = ["work/", "runtime/"].filter((entry) => !new RegExp(`^${entry}$`, "m").test(current));
  if (missing.length > 0) fs.writeFileSync(file, `${current.trimEnd()}\n${missing.join("\n")}\n`, "utf8");
  return file;
}
