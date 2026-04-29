import net from "node:net";
import { loadConfig } from "../core/config.js";
import { ConverseService } from "../core/service.js";
const extractAssistantText = (message) => {
    const candidate = message;
    if (candidate.role !== "assistant")
        return "";
    if (typeof candidate.content === "string")
        return candidate.content;
    if (Array.isArray(candidate.content)) {
        return candidate.content
            .map((item) => {
            if (typeof item === "string")
                return item;
            if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
                return item.text;
            }
            return "";
        })
            .join("\n")
            .trim();
    }
    return "";
};
export default function conversePiExtension(pi) {
    const config = loadConfig();
    let latestCtx;
    let service;
    let claimServer;
    const renderIdleStatus = () => {
        if (!latestCtx?.hasUI)
            return;
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
            await new Promise((resolve) => server.close(() => resolve()));
        }
        if (service) {
            const current = service;
            service = undefined;
            await current.stop();
        }
        renderIdleStatus();
    };
    const startService = async (ctx) => {
        if (service)
            return;
        latestCtx = ctx;
        claimServer = net.createServer((socket) => {
            socket.end();
        });
        await new Promise((resolve, reject) => {
            const onError = (error) => reject(error);
            claimServer.once("error", onError);
            claimServer.listen(config.port, config.host, () => {
                claimServer.off("error", onError);
                resolve();
            });
        });
        const ownerId = ctx.sessionManager.getSessionFile() ?? "pi-session";
        service = new ConverseService(config, ownerId);
        service.on("final-transcript", (entry) => {
            const text = `Transcribed: ${entry.text}`;
            if (ctx.isIdle())
                pi.sendUserMessage(text);
            else
                pi.sendUserMessage(text, { deliverAs: "steer" });
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
        await stopService();
    });
    pi.on("message_end", async (event, _ctx) => {
        if (!service)
            return;
        const text = extractAssistantText(event.message);
        if (text)
            await service.speak(text, service.ownerId);
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
                ctx.ui.notify("voice mode on", "info");
            }
            catch (error) {
                await stopService();
                const message = error instanceof Error ? error.message : String(error);
                ctx.ui.notify(`voice mode unavailable: ${message}`, "error");
            }
        },
    });
}
