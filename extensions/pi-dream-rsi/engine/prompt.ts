/**
 * Prompt loading and variable substitution.
 *
 * Agent prompts are shipped in `prompts/`; the runtime fills their named placeholders.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { PROMPTS_DIR } from "../layout.ts";

export const PROMPT_DIR = PROMPTS_DIR;

export function loadPrompt(name: string, dir: string = PROMPT_DIR): string {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) throw new Error(`missing prompt template: ${file}`);
  return fs.readFileSync(file, "utf8");
}

/** Replace `$key` and `{key}` placeholders. Longest keys first so no key eats another's prefix. */
export function renderPrompt(template: string, vars: Record<string, string | number | null | undefined>): string {
  let out = template;
  const keys = Object.keys(vars).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const value = vars[key] ?? "";
    out = out.replaceAll(`$${key}`, String(value)).replaceAll(`{${key}}`, String(value));
  }
  return out;
}
