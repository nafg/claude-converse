import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export default async function conversePiLoader(pi) {
  // Copy the emitted tree so all relative imports bypass Node's module cache
  // when Pi reloads a local package during development.
  const runtimeDir = await mkdtemp(join(tmpdir(), "converse-pi-"));
  await cp(new URL("../dist/", import.meta.url), runtimeDir, { recursive: true });
  await symlink(fileURLToPath(new URL("../node_modules/", import.meta.url)), join(runtimeDir, "node_modules"), "dir");
  const mod = await import(pathToFileURL(join(runtimeDir, "pi", "index.js")).href);
  const result = await mod.default(pi);
  pi.on("session_shutdown", async () => {
    await rm(runtimeDir, { recursive: true, force: true });
  });
  return result;
}
