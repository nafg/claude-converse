import net from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "../core/config.js";
import { ConverseService } from "../core/service.js";
import { VoiceWaitCoordinator } from "./voice-wait.js";

const extractAssistantText = (message: unknown): string => {
  const candidate = message as { role?: string; content?: unknown };
  if (candidate.role !== "assistant") return "";
  if (typeof candidate.content === "string") return candidate.content;
  if (Array.isArray(candidate.content)) {
    return candidate.content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item && typeof (item as { text?: unknown }).text === "string") {
          return (item as { text: string }).text;
        }
        return "";
      })
      .join("\n")
      .trim();
  }
  return "";
};

export default function conversePiExtension(pi: ExtensionAPI) {
  const config = loadConfig();
  const voiceWait = new VoiceWaitCoordinator();
  let latestCtx: ExtensionContext | undefined;
  let service: ConverseService | undefined;
  let claimServer: net.Server | undefined;
  const speechTasks = new Set<Promise<void>>();

  const renderIdleStatus = () => {
    if (!latestCtx?.hasUI) return;
    if (!service) {
      latestCtx.ui.setStatus("converse", undefined);
      latestCtx.ui.setWidget("converse", undefined);
      return;
    }
    const statusText = service.renderStatus(service.ownerId);
    latestCtx.ui.setStatus("converse", latestCtx.ui.theme.fg("accent", statusText || "🎤 active"));
    latestCtx.ui.setWidget("converse", statusText ? [statusText] : undefined, { placement: "belowEditor" });
  };

  const stopService = async () => {
    if (claimServer) {
      const server = claimServer;
      claimServer = undefined;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (service) {
      const current = service;
      service = undefined;
      await current.stop();
    }
    await Promise.allSettled(speechTasks);
    renderIdleStatus();
  };

  const startService = async (ctx: ExtensionContext) => {
    if (service) return;
    latestCtx = ctx;
    claimServer = net.createServer((socket) => {
      socket.end();
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      claimServer!.once("error", onError);
      claimServer!.listen(config.port, config.host, () => {
        claimServer!.off("error", onError);
        resolve();
      });
    });

    const ownerId = ctx.sessionManager.getSessionFile() ?? "pi-session";
    service = new ConverseService(config, ownerId);
    service.on("final-transcript", (entry) => {
      voiceWait.noteTranscript();
      const text = `Transcribed: ${entry.text}`;
      if (ctx.isIdle()) pi.sendUserMessage(text);
      else pi.sendUserMessage(text, { deliverAs: "steer" });
      renderIdleStatus();
    });
    service.on("partial-transcript", () => renderIdleStatus());
    service.on("error", (error) => ctx.ui.notify(`converse error: ${error.message}`, "error"));
    await service.start();
    renderIdleStatus();
  };

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    renderIdleStatus();
  });

  pi.on("session_shutdown", async () => {
    voiceWait.cancel();
    await stopService();
  });

  pi.on("turn_start", () => {
    voiceWait.beginTurn();
  });

  pi.on("message_end", (event, ctx) => {
    if (!service) return;
    const text = extractAssistantText(event.message);
    if (!text) return;

    const current = service;
    let task: Promise<void>;
    task = current.speak(text, current.ownerId)
      .then(() => undefined)
      .catch((error: unknown) => {
        if (service !== current) return;
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`converse error: ${message}`, "error");
      })
      .finally(() => speechTasks.delete(task));
    speechTasks.add(task);
  });

  pi.registerTool({
    name: "wait_for_voice",
    label: "Wait for voice",
    description: "Wait briefly for more voice input when a user message beginning with 'Transcribed:' appears semantically unfinished. Returns immediately if continuation has already arrived during the current turn.",
    promptSnippet: "Wait for continuation of an unfinished voice transcription",
    promptGuidelines: [
      "Use wait_for_voice before answering a 'Transcribed:' user message only when the thought appears unfinished, such as a trailing conjunction, filler, or incomplete sentence.",
      "When using wait_for_voice, do not tell the user that you are waiting and do not emit an acknowledgement first.",
      "If wait_for_voice reports that continuation is queued, do not answer the earlier fragment separately; incorporate the queued continuation on the next turn.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const outcome = await voiceWait.wait(config.voiceWaitMs, signal);
      const text = outcome === "continued"
        ? "More voice input is queued. Incorporate it before answering."
        : outcome === "timeout"
          ? "No continuation arrived before the timeout. Respond to the available transcription."
          : "Voice wait was cancelled.";
      return {
        content: [{ type: "text", text }],
        details: { outcome },
      };
    },
  });

  pi.registerCommand("converse", {
    description: "Turn voice mode on or off",
    handler: async (args, ctx) => {
      const mode = args.trim();
      if (mode === "off") {
        await stopService();
        ctx.ui.notify("voice mode off", "info");
        return;
      }
      try {
        await startService(ctx);
        const sttBackend = config.sttProvider === "openai"
          ? "OpenAI"
          : config.sttProvider === "groq"
            ? "Groq"
            : config.sttProvider === "speaches"
              ? "Speaches"
              : config.sttProvider === "whisper.cpp"
                ? "whisper.cpp"
                : "local Whisper";
        const ttsBackend = config.ttsProvider === "openai"
          ? "OpenAI"
          : config.ttsProvider === "speaches-kokoro"
            ? "Speaches Kokoro ONNX"
            : config.ttsProvider === "kokoro"
              ? "Kokoro"
              : "local Kokoro";
        ctx.ui.notify(`voice mode on (STT: ${sttBackend}; TTS: ${ttsBackend})`, "info");
      } catch (error) {
        await stopService();
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`voice mode unavailable: ${message}`, "error");
      }
    },
  });
}
