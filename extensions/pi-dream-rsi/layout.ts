/**
 * Where this package lives, however it was loaded.
 *
 * pi loads extensions three ways (docs/extensions.md §Extension Styles): as a package declared in
 * `package.json` (`pi install`), as an auto-discovered directory (`~/.pi/agent/extensions/<name>/index.ts`),
 * or as an explicit path (`pi -e`). Counting `..` levels only works for the first, so we resolve the
 * package root by searching upward for the shipped prompts instead.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Directory of this extension (`…/extensions/pi-dream-rsi`). */
export const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));

const PROMPT_MARKER = path.join("prompts", "discovery-agent.md");

function findPackageRoot(start: string): string | null {
  let dir = start;
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(dir, PROMPT_MARKER))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Package root. The documented layout is the fallback when nothing was found (a clear error follows). */
export const PACKAGE_DIR = findPackageRoot(EXTENSION_DIR) ?? path.resolve(EXTENSION_DIR, "..", "..");

export const PROMPTS_DIR = path.join(PACKAGE_DIR, "prompts");
export const SKILLS_DIR = path.join(PACKAGE_DIR, "skills");
/** The shipped policy API + baseline policy that gets seeded into a project. */
export const BUNDLED_POLICY_DIR = path.join(EXTENSION_DIR, "policy");
