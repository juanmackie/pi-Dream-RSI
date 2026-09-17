/**
 * Distribution layouts: the extension must find its prompts, skills and bundled policy whether it is
 * loaded as a package (`pi install`), as an explicit path (`pi -e`), or as a directory copied into
 * `.pi/extensions/<name>/` (docs/extensions.md §Extension Styles).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { EXT, REPO, exists } from "./fixtures.mjs";

test("the shipped package resolves its own prompts, skills and policy", async () => {
  const layout = await import(pathToFileURL(path.join(EXT, "layout.ts")).href);
  assert.equal(path.resolve(layout.PACKAGE_DIR), path.resolve(REPO));
  assert.ok(exists(path.join(layout.PROMPTS_DIR, "discovery-agent.md")));
  assert.ok(exists(path.join(layout.PROMPTS_DIR, "policy-improvement.md")));
  assert.ok(exists(path.join(layout.SKILLS_DIR, "dream-rsi", "SKILL.md")));
  assert.ok(exists(path.join(layout.BUNDLED_POLICY_DIR, "method.ts")));
  assert.ok(exists(path.join(layout.BUNDLED_POLICY_DIR, "api.ts")));

  const { loadPrompt } = await import(pathToFileURL(path.join(EXT, "engine", "prompt.ts")).href);
  assert.match(loadPrompt("discovery-agent.md"), /read every historical proposal/);
  assert.match(loadPrompt("policy-improvement.md"), /prefix-only exploration policy/);
  assert.throws(() => loadPrompt("nope.md"), /missing prompt template/);
});

test("a relocated copy under .pi/extensions still finds its resources", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-layout-"));
  const target = path.join(dir, ".pi", "extensions", "pi-dream-rsi");
  try {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of ["extensions", "prompts", "skills"]) {
      fs.cpSync(path.join(REPO, entry), path.join(target, entry), { recursive: true });
    }
    fs.copyFileSync(path.join(REPO, "package.json"), path.join(target, "package.json"));

    const layout = await import(pathToFileURL(path.join(target, "extensions", "pi-dream-rsi", "layout.ts")).href);
    assert.equal(path.resolve(layout.PACKAGE_DIR), path.resolve(target), "package root found by searching upward");
    assert.ok(exists(path.join(layout.PROMPTS_DIR, "discovery-agent.md")));
    assert.ok(exists(path.join(layout.SKILLS_DIR, "dream-rsi", "SKILL.md")));
    // The bundled policy ships *inside* the extension directory, so it moves with it.
    assert.ok(exists(path.join(layout.BUNDLED_POLICY_DIR, "method.ts")));

    const { loadPrompt } = await import(pathToFileURL(path.join(target, "extensions", "pi-dream-rsi", "engine", "prompt.ts")).href);
    assert.match(loadPrompt("discovery-agent.md"), /read every historical proposal/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
