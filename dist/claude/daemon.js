#!/usr/bin/env node
import http from "node:http";
import process from "node:process";
import { loadConfig } from "../core/config.js";
import { ConverseService } from "../core/service.js";
const argv = new Map();
for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.split("=", 2);
    if (key.startsWith("--") && value)
        argv.set(key.slice(2), value);
}
const ownerId = argv.get("owner-id") ?? process.env.CLAUDE_SESSION_ID ?? "";
if (!ownerId) {
    console.error("missing owner id");
    process.exit(2);
}
const config = loadConfig();
const service = new ConverseService(config, ownerId);
const finalSubscribers = new Set();
const readBody = async (request) => {
    const chunks = [];
    for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
};
service.on("final-transcript", (entry) => {
    for (const response of finalSubscribers)
        response.write(entry.text + "\n");
});
service.on("error", (error) => console.error(error));
const server = http.createServer(async (request, response) => {
    try {
        const url = new URL(request.url ?? "/", `http://${config.host}:${config.port}`);
        if (request.method === "GET" && url.pathname === "/healthz") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ ok: true, ownerId }));
            return;
        }
        if (request.method === "GET" && url.pathname === "/v1/transcriptions/final") {
            const requestOwner = url.searchParams.get("owner_id") ?? "";
            if (!requestOwner || requestOwner !== ownerId) {
                response.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
                response.end("owner mismatch\n");
                return;
            }
            response.writeHead(200, {
                "content-type": "text/plain; charset=utf-8",
                "cache-control": "no-cache, no-transform",
                connection: "keep-alive",
            });
            finalSubscribers.add(response);
            request.on("close", () => finalSubscribers.delete(response));
            return;
        }
        if (request.method === "GET" && url.pathname === "/v1/status") {
            const requestOwner = url.searchParams.get("owner_id") ?? "";
            const text = service.renderStatus(requestOwner);
            response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
            response.end(text);
            return;
        }
        if (request.method === "POST" && url.pathname === "/v1/speak") {
            const body = await readBody(request);
            const payload = JSON.parse(body);
            const spoken = await service.speak(payload.text ?? "", payload.owner_id ?? "");
            response.writeHead(spoken ? 202 : 409, { "content-type": "application/json" });
            response.end(JSON.stringify({ spoken }));
            return;
        }
        if (request.method === "POST" && url.pathname === "/v1/shutdown") {
            const body = await readBody(request);
            const payload = body ? JSON.parse(body) : {};
            if ((payload.owner_id ?? "") !== ownerId) {
                response.writeHead(409, { "content-type": "application/json" });
                response.end(JSON.stringify({ stopped: false }));
                return;
            }
            response.writeHead(202, { "content-type": "application/json" });
            response.end(JSON.stringify({ stopped: true }));
            setImmediate(() => shutdown(0));
            return;
        }
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("not found\n");
    }
    catch (error) {
        console.error(error);
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
});
const shutdown = async (code) => {
    for (const subscriber of finalSubscribers)
        subscriber.end();
    finalSubscribers.clear();
    await service.stop();
    await new Promise((resolve) => server.close(() => resolve()));
    process.exit(code);
};
process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));
server.listen(config.port, config.host, async () => {
    try {
        await service.start();
    }
    catch (error) {
        console.error(error);
        await shutdown(1);
    }
});
