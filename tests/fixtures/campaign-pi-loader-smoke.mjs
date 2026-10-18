import * as path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { EXT, makeProject, mockPi } from "../fixtures.mjs";

const configuredPackageRoot = process.env.DREAM_RSI_PI_PACKAGE_ROOT;
const packageEntry = configuredPackageRoot
  ? path.join(configuredPackageRoot, "dist", "index.js")
  : fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const packageRoot = path.dirname(path.dirname(packageEntry));
const loader = await import(pathToFileURL(path.join(packageRoot, "dist", "core", "extensions", "loader.js")).href);
const { loadExtensions, createExtensionRuntime } = loader;
const project = makeProject();

try {
  const loaded = await loadExtensions([path.join(EXT, "index.ts")], project.projectDir, undefined, createExtensionRuntime());
  if (loaded.errors.length > 0) throw new Error(loaded.errors.map((item) => item.error).join("\n"));
  const extension = loaded.extensions.find((item) => item.tools.has("dream_rsi_loop"));
  if (!extension) throw new Error("Pi loader did not register dream_rsi_loop");
  if (extension.tools.has("dream_rsi_improve")) throw new Error("Pi loader registered the removed improve tool");

  const bundle = mockPi();
  const context = bundle.context;
  context.cwd = project.projectDir;
  loaded.runtime.getActiveTools = () => bundle.harness.activeTools;
  loaded.runtime.setActiveTools = (tools) => { bundle.harness.activeTools = [...tools]; };
  loaded.runtime.appendEntry = (customType, data) => bundle.harness.entries.push({ type: "custom", customType, data });
  await extension.handlers.get("session_start")?.[0]?.({}, context);
  const status = await extension.tools.get("dream_rsi_loop").definition.execute("loader-status", { action: "status" }, undefined, undefined, context);
  process.stdout.write(`${JSON.stringify({
    tools: [...extension.tools.keys()].sort(),
    status: status.content?.[0]?.text ?? "",
    campaign: status.details?.campaign ?? null,
  })}\n`);
} finally {
  project.cleanup();
}