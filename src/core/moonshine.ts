import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import type { MoonshineLanguage, MoonshineModel } from "./config.js";

export interface MoonshineClientOptions {
  pythonCommand: string;
  sidecarPath: string;
  language: MoonshineLanguage;
  model: MoonshineModel;
  timeoutMs: number;
}

type PendingRequest = {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type ProtocolMessage = {
  type?: unknown;
  id?: unknown;
  text?: unknown;
  error?: unknown;
};

const MAX_STDERR_CHARS = 4_000;
const STOP_GRACE_MS = 2_000;

/** Owns one persistent Moonshine Python process and correlates concurrent requests. */
export class MoonshineClient {
  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = "";
  private stderrTail = "";
  private nextRequestId = 1;
  private pending = new Map<string, PendingRequest>();
  private startPromise?: Promise<void>;
  private resolveStart?: () => void;
  private rejectStart?: (error: Error) => void;
  private stoppingChildren = new Set<ChildProcessWithoutNullStreams>();

  constructor(
    private readonly options: MoonshineClientOptions,
    private readonly onDiagnostic: (error: Error) => void = () => undefined,
  ) {}

  async start(): Promise<void> {
    if (this.child && this.startPromise) return this.startPromise;

    this.stdoutBuffer = "";
    this.stderrTail = "";
    const child = spawn(this.options.pythonCommand, [
      this.options.sidecarPath,
      "--language",
      this.options.language,
      "--model",
      this.options.model,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });

    const startupTimer = setTimeout(() => {
      this.failAndKill(new Error(`Moonshine sidecar did not become ready within ${this.options.timeoutMs}ms`));
    }, this.options.timeoutMs);
    this.startPromise.finally(() => clearTimeout(startupTimer)).catch(() => undefined);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_CHARS);
    });
    child.on("error", (error) => this.failAndKill(new Error(`Moonshine sidecar failed to start: ${error.message}`)));
    child.on("close", (code, signal) => this.onClose(child, code, signal));
    child.stdin.on("error", (error) => {
      if (!this.stoppingChildren.has(child)) this.failAndKill(new Error(`Moonshine sidecar input failed: ${error.message}`));
    });

    return this.startPromise;
  }

  async transcribe(audio: Buffer, sampleRate: number, channels: number): Promise<string> {
    await this.start();
    const child = this.child;
    if (!child || child.exitCode !== null || child.killed) throw new Error("Moonshine sidecar is not running");

    const id = String(this.nextRequestId++);
    const result = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        const error = new Error(`Moonshine transcription timed out after ${this.options.timeoutMs}ms`);
        pending.reject(error);
        this.failAndKill(error);
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });

    const request = JSON.stringify({
      type: "transcribe",
      id,
      sampleRate,
      channels,
      pcmS16Le: audio.toString("base64"),
    }) + "\n";
    try {
      if (!child.stdin.write(request)) await once(child.stdin, "drain");
    } catch (error) {
      const pending = this.pending.get(id);
      const failure = new Error(`Moonshine sidecar request write failed: ${error instanceof Error ? error.message : String(error)}`);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(failure);
      }
      this.failAndKill(failure);
      return result;
    }
    return result;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stoppingChildren.add(child);
    this.child = undefined;
    child.stdout.removeAllListeners("data");
    const stopped = new Error("Moonshine sidecar stopped");
    this.rejectStartup(stopped);
    this.rejectEverything(stopped);
    if (child.exitCode !== null) {
      this.resetStartState();
      return;
    }

    const closed = once(child, "close").then(() => undefined);
    child.kill("SIGTERM");
    const forced = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, STOP_GRACE_MS);
      timer.unref();
    });
    await Promise.race([closed, forced]);
    this.resetStartState();
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let message: ProtocolMessage;
    try {
      message = JSON.parse(line) as ProtocolMessage;
    } catch {
      this.failAndKill(new Error(`Moonshine sidecar returned invalid JSON: ${line.slice(0, 200)}`));
      return;
    }

    if (message.type === "ready") {
      if (!this.resolveStart) {
        this.failAndKill(new Error("Moonshine sidecar sent an unexpected ready message"));
        return;
      }
      const resolve = this.resolveStart;
      this.resolveStart = undefined;
      this.rejectStart = undefined;
      resolve();
      return;
    }

    if (message.type === "fatal" && typeof message.error === "string") {
      this.failAndKill(new Error(`Moonshine sidecar initialization failed: ${message.error}`));
      return;
    }

    if (message.type !== "result" || typeof message.id !== "string") {
      this.failAndKill(new Error("Moonshine sidecar returned an invalid protocol message"));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.onDiagnostic(new Error(`Moonshine sidecar returned unknown request id ${message.id}`));
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (typeof message.error === "string") {
      pending.reject(new Error(`Moonshine transcription failed: ${message.error}`));
    } else if (typeof message.text === "string") {
      pending.resolve(message.text.trim());
    } else {
      pending.reject(new Error("Moonshine sidecar result contained neither text nor an error"));
    }
  }

  private onClose(child: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child === child) this.child = undefined;
    if (this.stoppingChildren.delete(child)) return;
    const stderr = this.stderrTail.trim().replace(/\s+/g, " ");
    const detail = stderr ? `: ${stderr}` : "";
    this.fail(new Error(`Moonshine sidecar exited unexpectedly: code=${code} signal=${signal}${detail}`));
  }

  private failAndKill(error: Error): void {
    const child = this.child;
    this.fail(error);
    if (child && child.exitCode === null && !child.killed) child.kill("SIGTERM");
  }

  private fail(error: Error): void {
    const rejectedStartup = this.rejectStartup(error);
    this.rejectEverything(error);
    if (!rejectedStartup) this.onDiagnostic(error);
  }

  private rejectStartup(error: Error): boolean {
    const rejectStart = this.rejectStart;
    this.resolveStart = undefined;
    this.rejectStart = undefined;
    rejectStart?.(error);
    return rejectStart !== undefined;
  }

  private rejectEverything(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private resetStartState(): void {
    this.startPromise = undefined;
    this.resolveStart = undefined;
    this.rejectStart = undefined;
    this.stdoutBuffer = "";
  }
}
