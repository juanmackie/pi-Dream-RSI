import * as path from "node:path";

function normalizeRelativePath(value: string, allowRoot: boolean): string | null {
  const portable = value.replace(/\\/g, "/");
  if (portable.includes("\0") || portable.startsWith("/") || /^[a-z]:/i.test(portable) || portable.split("/").includes("..")) return null;
  const normalized = path.posix.normalize(portable).replace(/\/+$/, "");
  if (normalized === ".") return allowRoot ? "" : null;
  if (!normalized || normalized.startsWith("../")) return null;
  return normalized;
}

/** Normalize one file path and reject absolute paths, directories, and traversal. */
export function normalizeProjectRelativePath(relative: string): string | null {
  if (typeof relative !== "string" || !relative.trim() || relative.endsWith("/") || relative.endsWith("\\")) return null;
  return normalizeRelativePath(relative, false);
}

/** True when a project-relative path is within one of the declared roots. */
export function pathWithin(relative: string, roots: readonly string[] | null): boolean {
  const candidate = normalizeRelativePath(relative, true);
  if (candidate === null) return false;
  if (roots === null || roots.length === 0) return true;
  return roots.some((entry) => {
    const root = normalizeRelativePath(entry, true);
    return root !== null && (root === "" || candidate === root || candidate.startsWith(`${root}/`));
  });
}

/** True when a planned file or directory intersects a protected file or directory. */
export function pathProtected(relative: string, protectedAssets: readonly string[]): boolean {
  const normalize = (value: string): string => {
    const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    return normalized === "." ? "" : normalized;
  };
  const candidate = normalize(relative);
  return protectedAssets.some((asset) => {
    const protectedPath = normalize(asset);
    const left = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    const right = process.platform === "win32" ? protectedPath.toLowerCase() : protectedPath;
    return pathWithin(left, [right]) || pathWithin(right, [left]);
  });
}
