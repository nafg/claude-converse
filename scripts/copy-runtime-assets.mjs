import { cp, mkdir } from "node:fs/promises";

await mkdir(new URL("../dist/services/", import.meta.url), { recursive: true });
await cp(
  new URL("../services/moonshine-sidecar.py", import.meta.url),
  new URL("../dist/services/moonshine-sidecar.py", import.meta.url),
);
