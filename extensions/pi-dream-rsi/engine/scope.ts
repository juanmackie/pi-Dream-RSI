/** True when a project-relative path is within one of the declared roots. */
export function pathWithin(relative: string, roots: readonly string[] | null): boolean {
  if (roots === null || roots.length === 0) return true;
  const normalize = (value: string): string => {
    const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    return normalized === "." ? "" : normalized;
  };
  const candidate = normalize(relative);
  return roots.some((entry) => {
    const root = normalize(entry);
    return root === "" || candidate === root || candidate.startsWith(`${root}/`);
  });
}
