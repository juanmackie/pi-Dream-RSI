import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("npm package includes user docs but excludes internal remediation artifacts", () => {
  const args = ["pack", "--dry-run", "--json"];
  const output = process.env.npm_execpath
    ? execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    : process.platform === "win32"
      ? execFileSync("cmd.exe", ["/d", "/s", "/c", "npm pack --dry-run --json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      : execFileSync("npm", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const [pack] = JSON.parse(output);
  assert.ok(pack && Array.isArray(pack.files), "npm returns the package file manifest");
  const paths = new Set(pack.files.map((file) => file.path));
  assert.ok(paths.has("docs/autonomous-loop.md"));
  assert.ok(paths.has("docs/continuous-magnitude.md"));
  assert.ok(paths.has("docs/method.md"));
  assert.equal([...paths].some((file) => file.startsWith("docs/reports/")), false,
    "internal remediation reports and patches must not ship to npm");
});
