import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import conversePiExtension from "./index.js";

const envNames = [
  "CONVERSE_PORT",
  "CONVERSE_RECORDER_COMMAND",
  "CONVERSE_VOICE_PROVIDER",
  "OPENAI_API_KEY",
] as const;
const originalEnv = new Map(envNames.map((name) => [name, process.env[name]]));

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of envNames) {
    const value = originalEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("Pi converse extension", () => {
  it("does not await speech playback from message_end", async () => {
    const recorderCommand = join(tmpdir(), `converse-test-recorder-${process.pid}`);
    writeFileSync(recorderCommand, "#!/bin/sh\nexec sleep 60\n");
    chmodSync(recorderCommand, 0o755);
    process.env.CONVERSE_PORT = "0";
    process.env.CONVERSE_RECORDER_COMMAND = recorderCommand;
    process.env.CONVERSE_VOICE_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-key";

    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    let converseCommand: { handler(args: string, ctx: unknown): Promise<void> } | undefined;
    let waitTool: { name: string; promptGuidelines?: string[] } | undefined;
    const pi = {
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        const current = handlers.get(name) ?? [];
        current.push(handler);
        handlers.set(name, current);
      },
      registerCommand(name: string, command: typeof converseCommand) {
        if (name === "converse") converseCommand = command;
      },
      registerTool(tool: typeof waitTool) {
        if (tool?.name === "wait_for_voice") waitTool = tool;
      },
      sendUserMessage: vi.fn(),
    };
    const ui = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      theme: { fg: (_color: string, text: string) => text },
    };
    const ctx = {
      hasUI: false,
      isIdle: () => true,
      sessionManager: { getSessionFile: () => "test-session" },
      ui,
    };

    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
      });
    }));

    try {
      conversePiExtension(pi as never);
      expect(waitTool?.promptGuidelines?.join(" ")).toMatch(/do not tell the user that you are waiting/i);
      await converseCommand!.handler("on", ctx);
      const messageEnd = handlers.get("message_end")![0]!;
      let settled = false;
      const result = Promise.resolve(messageEnd({ message: { role: "assistant", content: "Long reply." } }, ctx))
        .then(() => { settled = true; });
      await vi.waitFor(() => expect(requestSignal).toBeDefined());
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(settled).toBe(true);
      await Promise.resolve(handlers.get("session_shutdown")![0]!({}, ctx));
      await result;
    } finally {
      rmSync(recorderCommand, { force: true });
    }
  });
});
