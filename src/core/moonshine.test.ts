import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MoonshineClient } from "./moonshine.js";

const directories: string[] = [];

const fakeSidecar = (): string => {
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
console.log(JSON.stringify({ type: "ready" }));
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

const client = (sidecarPath: string, timeoutMs = 500, diagnostics: Error[] = []) => new MoonshineClient({
  pythonCommand: process.execPath,
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

  it("can restart cleanly after an explicit stop", async () => {
    const moonshine = client(fakeSidecar());
    const first = await moonshine.transcribe(Buffer.from([5, 0]), 16_000, 1);
    await moonshine.stop();
    const second = await moonshine.transcribe(Buffer.from([5, 0]), 16_000, 1);
    await moonshine.stop();

    expect(first.split(":")[3]).not.toBe(second.split(":")[3]);
  });
});
