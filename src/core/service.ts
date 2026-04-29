import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { ConverseConfig } from "./config.js";
import { encodeWav } from "./wav.js";
import { hashText, speakableText, splitSpeechChunks } from "./text.js";
import type { TranscriptEntry } from "./types.js";
import { EnergyVad, type VadEmission } from "./vad.js";

interface ServiceEvents {
  "partial-transcript": [TranscriptEntry];
  "final-transcript": [TranscriptEntry];
  "barge-in": [];
  error: [Error];
}

export class ConverseService extends EventEmitter<ServiceEvents> {
  private readonly vad: EnergyVad;
  private recorder?: ChildProcess;
  private recorderCarry = Buffer.alloc(0);
  private recentEntries: TranscriptEntry[] = [];
  private activeTts?: ChildProcess;
  private speakGeneration = 0;
  private lastSpokenHash?: string;

  constructor(
    private readonly config: ConverseConfig,
    public readonly ownerId: string,
  ) {
    super();
    this.vad = new EnergyVad(config);
  }

  async start(): Promise<void> {
    if (this.recorder) return;
    const args = this.recorderArgs();
    const recorder = spawn(this.config.recorderCommand, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.recorder = recorder;
    recorder.stdout.on("data", (chunk: Buffer) => this.onRecorderData(chunk));
    recorder.stderr.on("data", () => undefined);
    recorder.on("error", (error) => this.emit("error", error));
    recorder.on("close", (code, signal) => {
      this.recorder = undefined;
      if (code !== 0 && signal !== "SIGTERM") {
        this.emit("error", new Error(`Recorder exited unexpectedly: code=${code} signal=${signal}`));
      }
    });
  }

  async stop(): Promise<void> {
    this.stopSpeaking();
    const recorder = this.recorder;
    this.recorder = undefined;
    if (recorder && !recorder.killed) recorder.kill("SIGTERM");
  }

  renderStatus(ownerId: string): string {
    if (ownerId !== this.ownerId) return "";
    const indicator = this.config.statusPrefix.trimEnd();
    const cutoff = Date.now() - this.config.statusWindowSeconds * 1000;
    const fresh = this.recentEntries.filter((entry) => entry.ts >= cutoff);
    if (fresh.length === 0) return indicator;
    const texts = fresh.map((entry) => entry.text).filter(Boolean);
    if (texts.length === 0) return indicator;
    return this.config.statusPrefix + texts.join(this.config.statusSeparator);
  }

  async speak(text: string, ownerId: string): Promise<boolean> {
    if (ownerId !== this.ownerId) return false;
    const source = speakableText(text);
    if (!source) return false;
    const digest = hashText(source);
    if (digest === this.lastSpokenHash) return false;
    this.lastSpokenHash = digest;
    this.stopSpeaking();
    const generation = ++this.speakGeneration;

    for (const chunk of splitSpeechChunks(source)) {
      if (generation !== this.speakGeneration) return false;
      const wav = await this.synthesize(chunk.text);
      if (generation !== this.speakGeneration) return false;
      await this.playWav(wav, generation);
      if (generation !== this.speakGeneration) return false;
      if (chunk.pauseSeconds > 0) await sleep(chunk.pauseSeconds * 1000);
    }

    return true;
  }

  stopSpeaking(): void {
    this.speakGeneration += 1;
    if (this.activeTts && !this.activeTts.killed) this.activeTts.kill("SIGTERM");
    this.activeTts = undefined;
  }

  private onRecorderData(chunk: Buffer): void {
    this.recorderCarry = Buffer.concat([this.recorderCarry, chunk]);
    const frameBytes = this.vad.getFrameBytes();
    while (this.recorderCarry.length >= frameBytes) {
      const frame = this.recorderCarry.subarray(0, frameBytes);
      this.recorderCarry = this.recorderCarry.subarray(frameBytes);
      for (const emission of this.vad.pushFrame(frame)) {
        void this.handleVadEmission(emission).catch((error: unknown) => {
          this.emit("error", error instanceof Error ? error : new Error(String(error)));
        });
      }
    }
  }

  private async handleVadEmission(emission: VadEmission): Promise<void> {
    if (emission.type === "barge-in") {
      this.stopSpeaking();
      this.emit("barge-in");
      return;
    }
    if (emission.type === "speech-start") return;
    const text = await this.transcribe(emission.audio);
    if (!text) return;
    const entry: TranscriptEntry = {
      id: emission.utteranceId,
      final: emission.type === "final",
      ts: Date.now(),
      text,
    };
    this.upsertRecent(entry);
    if (entry.final) this.emit("final-transcript", entry);
    else this.emit("partial-transcript", entry);
  }

  private upsertRecent(entry: TranscriptEntry): void {
    const existing = this.recentEntries.findIndex((candidate) => candidate.id === entry.id);
    if (existing !== -1) {
      const current = this.recentEntries[existing]!;
      if (current.final && !entry.final) return;
      this.recentEntries.splice(existing, 1);
    }
    this.recentEntries.push(entry);
    if (this.recentEntries.length > this.config.recentMaxEntries) {
      this.recentEntries = this.recentEntries.slice(-this.config.recentMaxEntries);
    }
  }

  private async transcribe(audio: Buffer): Promise<string> {
    const wav = encodeWav(audio, this.config.sampleRate, this.config.channels, this.config.bytesPerSample);
    const form = new FormData();
    form.set("model", this.config.whisperModel);
    form.set("response_format", "json");
    form.set("language", this.config.whisperLanguage);
    if (this.config.whisperPrompt) form.set("prompt", this.config.whisperPrompt);
    form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
    const response = await fetch(this.config.whisperUrl, { method: "POST", body: form });
    if (!response.ok) throw new Error(`Whisper request failed: ${response.status}`);
    const payload = (await response.json()) as { text?: string };
    return payload.text?.trim() ?? "";
  }

  private async synthesize(text: string): Promise<Buffer> {
    const response = await fetch(this.config.kokoroUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.config.kokoroModel,
        input: text,
        voice: this.config.kokoroVoice,
        response_format: "wav",
      }),
    });
    if (!response.ok) throw new Error(`Kokoro request failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  private recorderArgs(): string[] {
    const command = this.config.recorderCommand.split("/").pop() ?? this.config.recorderCommand;
    if (command === "parecord") {
      return [
        "--raw",
        "--format=s16le",
        `--rate=${this.config.sampleRate}`,
        `--channels=${this.config.channels}`,
        ...this.config.recorderAdditionalArgs,
      ];
    }
    return [
      "-q",
      "-D",
      this.config.recorderDevice,
      "-c",
      String(this.config.channels),
      "-f",
      "S16_LE",
      "-r",
      String(this.config.sampleRate),
      "-t",
      "raw",
      ...this.config.recorderAdditionalArgs,
      "-",
    ];
  }

  private playWav(wav: Buffer, generation: number): Promise<void> {
    const command = this.config.playerCommand.split("/").pop() ?? this.config.playerCommand;
    if (command === "paplay") return this.playWavViaTempFile(wav, generation);
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.playerCommand, ["-q", ...this.config.playerAdditionalArgs, "-"], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      this.activeTts = child;
      child.on("error", reject);
      child.stderr.on("data", () => undefined);
      child.on("close", (code, signal) => {
        if (this.activeTts === child) this.activeTts = undefined;
        if (generation !== this.speakGeneration || signal === "SIGTERM") {
          resolve();
          return;
        }
        if (code === 0) resolve();
        else reject(new Error(`Player exited unexpectedly: code=${code} signal=${signal}`));
      });
      child.stdin.on("error", reject);
      child.stdin.end(wav);
    });
  }

  private async playWavViaTempFile(wav: Buffer, generation: number): Promise<void> {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "converse-tts-"));
    const file = join(dir, "speech.wav");
    await writeFile(file, wav);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.config.playerCommand, [...this.config.playerAdditionalArgs, file], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        this.activeTts = child;
        child.on("error", reject);
        child.stderr.on("data", () => undefined);
        child.on("close", (code, signal) => {
          if (this.activeTts === child) this.activeTts = undefined;
          if (generation !== this.speakGeneration || signal === "SIGTERM") {
            resolve();
            return;
          }
          if (code === 0) resolve();
          else reject(new Error(`Player exited unexpectedly: code=${code} signal=${signal}`));
        });
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
