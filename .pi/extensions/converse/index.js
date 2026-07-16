import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export default async function converseHotReloadShim(pi) {
  // Use hosted audio for this project unless the user explicitly selects another provider.
  process.env.CONVERSE_VOICE_PROVIDER ??= "openai";

  // A query string reloads only index.js. Copy the emitted tree so its relative core
  // imports also bypass Node's module cache after Pi runs /reload.
  const runtimeDir = await mkdtemp(join(tmpdir(), "converse-pi-"));
  await cp(new URL("../../../dist/", import.meta.url), runtimeDir, { recursive: true });
  const mod = await import(pathToFileURL(join(runtimeDir, "pi", "index.js")).href);
  return mod.default(pi);
}
