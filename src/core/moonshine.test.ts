import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMoonshineSidecarPath } from "./config.js";
import { MoonshineClient } from "./moonshine.js";

const directories: string[] = [];

const fakeSidecar = (readyDelayMs = 0): string => {
  const directory = mkdtempSync(join(tmpdir(), "converse-moonshine-test-"));
  directories.push(directory);
  const script = join(directory, "fake-sidecar.mjs");
  writeFileSync(script, `
import readline from "node:readline";
const language = process.argv[process.argv.indexOf("--language") + 1];
const model = process.argv[process.argv.indexOf("--model") + 1];
if (language !== "en" || model !== "small-streaming") {
  console.log(JSON.stringify({ type: "fatal", error: "bad startup arguments" }));
  process.exit(1);
}
setTimeout(() => console.log(JSON.stringify({ type: "ready" })), ${readyDelayMs});
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  const audio = Buffer.from(request.pcmS16Le, "base64");
  const marker = audio[0];
  if (marker === 255) {
    console.error("simulated native crash");
    process.exit(7);
  }
  if (marker === 254) return;
  const response = marker === 253
    ? { type: "result", id: request.id, error: "simulated decode failure" }
    : { type: "result", id: request.id, text: String(marker) + ":" + request.sampleRate + ":" + request.channels + ":" + process.pid };
  setTimeout(() => console.log(JSON.stringify(response)), marker === 1 ? 30 : 0);
});
`);
  return script;
};

const client = (sidecarPath: string, timeoutMs = 500, diagnostics: Error[] = [], pythonCommand = process.execPath) => new MoonshineClient({
  pythonCommand,
  sidecarPath,
  language: "en",
  model: "small-streaming",
  timeoutMs,
}, (error) => diagnostics.push(error));

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("MoonshineClient", () => {
  it("loads one persistent sidecar and correlates overlapping requests", async () => {
    const moonshine = client(fakeSidecar());
    try {
      const [first, second] = await Promise.all([
        moonshine.transcribe(Buffer.from([1, 0]), 16_000, 1),
        moonshine.transcribe(Buffer.from([2, 0]), 48_000, 2),
      ]);

      expect(first).toMatch(/^1:16000:1:\d+$/);
      expect(second).toMatch(/^2:48000:2:\d+$/);
      expect(first.split(":")[3]).toBe(second.split(":")[3]);
    } finally {
      await moonshine.stop();
    }
  });

  it("returns correlated transcription errors without killing the sidecar", async () => {
    const moonshine = client(fakeSidecar());
    try {
      await expect(moonshine.transcribe(Buffer.from([253, 0]), 16_000, 1))
        .rejects.toThrow("Moonshine transcription failed: simulated decode failure");
      await expect(moonshine.transcribe(Buffer.from([4, 0]), 16_000, 1))
        .resolves.toMatch(/^4:16000:1:\d+$/);
    } finally {
      await moonshine.stop();
    }
  });

  it("rejects pending work with stderr diagnostics when the sidecar crashes", async () => {
    const moonshine = client(fakeSidecar());
    await expect(moonshine.transcribe(Buffer.from([255, 0]), 16_000, 1))
      .rejects.toThrow(/exited unexpectedly.*simulated native crash/);
    await moonshine.stop();
  });

  it("times out a stuck inference and terminates the unhealthy sidecar", async () => {
    const diagnostics: Error[] = [];
    const moonshine = client(fakeSidecar(), 50, diagnostics);
    await expect(moonshine.transcribe(Buffer.from([254, 0]), 16_000, 1))
      .rejects.toThrow("Moonshine transcription timed out after 50ms");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(diagnostics.some((error) => /timed out|exited unexpectedly/.test(error.message))).toBe(true);
    await moonshine.stop();
  });

  it("resolves and starts the sidecar from Pi's copied dist layout", async () => {
    const directory = mkdtempSync(join(tmpdir(), "converse-pi-runtime-test-"));
    directories.push(directory);
    const dist = join(directory, "package", "dist");
    mkdirSync(join(dist, "core"), { recursive: true });
    mkdirSync(join(dist, "services"), { recursive: true });
    writeFileSync(join(dist, "services", "moonshine-sidecar.py"), `
import json
import os
import sys
print(json.dumps({"type": "ready"}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    print(json.dumps({"type": "result", "id": request["id"], "text": "6:16000:1:" + str(os.getpid())}), flush=True)
`);
    const runtime = join(directory, "runtime");
    cpSync(dist, runtime, { recursive: true });

    const moduleUrl = pathToFileURL(join(runtime, "core", "config.js")).href;
    const sidecarPath = resolveMoonshineSidecarPath(moduleUrl);
    expect(sidecarPath).toBe(join(runtime, "services", "moonshine-sidecar.py"));

    const moonshine = client(sidecarPath, 500, [], "python3");
    try {
      await expect(moonshine.transcribe(Buffer.from([6, 0]), 16_000, 1))
        .resolves.toMatch(/^6:16000:1:\d+$/);
    } finally {
      await moonshine.stop();
    }
  });

  it("settles startup promptly when stopped before the sidecar is ready", async () => {
    const moonshine = client(fakeSidecar(10_000), 20_000);
    const startup = moonshine.start();
    const rejected = expect(startup).rejects.toThrow("Moonshine sidecar stopped");
    await new Promise((resolve) => setTimeout(resolve, 20));

    await moonshine.stop();
    await rejected;
  });

  it("can restart cleanly after an explicit stop", async () => {
    const moonshine = client(fakeSidecar());
    const first = await moonshine.transcribe(Buffer.from([5, 0]), 16_000, 1);
    await moonshine.stop();
    const second = await moonshine.transcribe(Buffer.from([5, 0]), 16_000, 1);
    await moonshine.stop();

    expect(first.split(":")[3]).not.toBe(second.split(":")[3]);
  });
});
