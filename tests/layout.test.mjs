import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { EXT, REPO, exists } from "./fixtures.mjs";

test("the package resolves discovery prompts and the v3 skills", async () => {
  const layout = await import(pathToFileURL(path.join(EXT, "layout.ts")).href);
  assert.equal(path.resolve(layout.PACKAGE_DIR), path.resolve(REPO));
  assert.ok(exists(path.join(layout.PROMPTS_DIR, "discovery-agent.md")));
  assert.ok(exists(path.join(layout.SKILLS_DIR, "dream-rsi", "SKILL.md")));
  assert.ok(exists(path.join(layout.SKILLS_DIR, "dream-rsi-assess", "SKILL.md")));
  assert.ok(exists(path.join(layout.SKILLS_DIR, "dream-rsi-loop", "SKILL.md")));
  assert.equal(exists(path.join(layout.SKILLS_DIR, "dream-rsi-improve")), false);
  const { loadPrompt } = await import(pathToFileURL(path.join(EXT, "engine", "prompt.ts")).href);
  assert.match(loadPrompt("discovery-agent.md"), /parent_summary/);
  assert.throws(() => loadPrompt("nope.md"), /missing prompt template/);
});

test("a relocated package still finds its prompt and skills", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-rsi-layout-"));
  const target = path.join(dir, ".pi", "extensions", "pi-dream-rsi");
  try {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of ["extensions", "prompts", "skills"]) {
      fs.cpSync(path.join(REPO, entry), path.join(target, entry), { recursive: true });
    }
    const layout = await import(pathToFileURL(path.join(target, "extensions", "pi-dream-rsi", "layout.ts")).href);
    assert.equal(path.resolve(layout.PACKAGE_DIR), path.resolve(target));
    assert.ok(exists(path.join(layout.PROMPTS_DIR, "discovery-agent.md")));
    assert.ok(exists(path.join(layout.SKILLS_DIR, "dream-rsi-loop", "SKILL.md")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});