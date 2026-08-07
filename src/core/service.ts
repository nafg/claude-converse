import { EventEmitter, once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { ConverseConfig } from "./config.js";
import { MoonshineClient } from "./moonshine.js";
import { encodeWav } from "./wav.js";
import { hashText, speakableText, splitSpeechChunks } from "./text.js";
import type { SpeechChunk, TranscriptEntry } from "./types.js";
import { EnergyVad, type VadEmission } from "./vad.js";

interface ServiceEvents {
  "partial-transcript": [TranscriptEntry];
  "final-transcript": [TranscriptEntry];
  "barge-in": [];
  error: [Error];
  diagnostic: [string];
}

/** Read timeout scaled to audio length: apiTimeoutMs floor, per-audio-second growth, hard cap. */
export const computeSttTimeoutMs = (
  audioByteLength: number,
  config: Pick<ConverseConfig, "sampleRate" | "channels" | "bytesPerSample" | "apiTimeoutMs" | "sttTimeoutPerAudioSecondMs" | "sttTimeoutCapMs">,
): number => {
  const seconds = audioByteLength / (config.sampleRate * config.channels * config.bytesPerSample);
  return Math.min(config.sttTimeoutCapMs, Math.max(config.apiTimeoutMs, Math.ceil(seconds * config.sttTimeoutPerAudioSecondMs)));
};

const isRetryableSttError = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === "TimeoutError" : error instanceof TypeError;

export class ConverseService extends EventEmitter<ServiceEvents> {
  private readonly vad: EnergyVad;
  private recorder?: ChildProcess;
  private moonshine?: MoonshineClient;
  private recorderCarry = Buffer.alloc(0);
  private recentEntries: TranscriptEntry[] = [];
  private activeTts?: ChildProcess;
  private speechAbortController?: AbortController;
  private readonly transcriptionAbortControllers = new Set<AbortController>();
  private readonly pendingVadTasks = new Set<Promise<void>>();
  private lifecycleGeneration = 0;
  private stopping?: Promise<void>;
  private recorderStopGraceMs = 1_000;
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
    if (this.stopping) await this.stopping;
    if (this.recorder) return;
    const generation = ++this.lifecycleGeneration;
    if (this.config.sttProvider === "moonshine") await this.ensureMoonshine();
    if (generation !== this.lifecycleGeneration) return;

    const args = this.recorderArgs();
    const recorder = spawn(this.config.recorderCommand, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.recorder = recorder;
    recorder.stdout.on("data", (chunk: Buffer) => this.onRecorderData(chunk, generation));
    recorder.stderr.on("data", () => undefined);
    recorder.on("error", (error) => {
      if (generation === this.lifecycleGeneration) this.emit("error", error);
    });
    recorder.on("close", (code, signal) => {
      if (this.recorder === recorder) this.recorder = undefined;
      if (generation === this.lifecycleGeneration && code !== 0 && signal !== "SIGTERM") {
        this.emit("error", new Error(`Recorder exited unexpectedly: code=${code} signal=${signal}`));
      }
    });
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const stopping = this.stopInternal();
    this.stopping = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopping === stopping) this.stopping = undefined;
    }
  }

  private async stopInternal(): Promise<void> {
    this.lifecycleGeneration += 1;
    this.stopSpeaking();
    for (const controller of this.transcriptionAbortControllers) controller.abort();
    this.transcriptionAbortControllers.clear();
    this.recorderCarry = Buffer.alloc(0);
    this.vad.reset();

    const recorder = this.recorder;
    this.recorder = undefined;
    const moonshine = this.moonshine;
    this.moonshine = undefined;
    const pendingVadTasks = [...this.pendingVadTasks];
    await Promise.all([
      recorder ? this.stopRecorder(recorder) : Promise.resolve(),
      moonshine ? moonshine.stop() : Promise.resolve(),
    ]);
    await Promise.allSettled(pendingVadTasks);
  }

  private async stopRecorder(recorder: ChildProcess): Promise<void> {
    if (recorder.exitCode !== null || recorder.signalCode !== null) return;
    const closed = once(recorder, "close").then(() => undefined).catch(() => undefined);
    recorder.kill("SIGTERM");
    const graceful = await Promise.race([
      closed.then(() => true),
      sleep(this.recorderStopGraceMs).then(() => false),
    ]);
    if (graceful || recorder.exitCode !== null || recorder.signalCode !== null) return;
    recorder.kill("SIGKILL");
    await closed;
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
    const abortController = new AbortController();
    this.speechAbortController = abortController;

    try {
      const chunks = splitSpeechChunks(source);
      if (this.config.ttsProvider === "openai") {
        return await this.speakHostedChunks(chunks, generation, abortController.signal);
      }
      if (this.config.ttsProvider === "pocket-tts") {
        return await this.speakPocketChunks(chunks, generation, abortController.signal);
      }

      for (const chunk of chunks) {
        if (generation !== this.speakGeneration) return false;
        const wav = await this.synthesize(chunk.text, abortController.signal);
        if (generation !== this.speakGeneration) return false;
        await this.playWav(wav, generation);
        if (generation !== this.speakGeneration) return false;
        if (chunk.pauseSeconds > 0) {
          await sleep(chunk.pauseSeconds * 1000, undefined, { signal: abortController.signal });
        }
      }

      return true;
    } catch (error) {
      if (abortController.signal.aborted) return false;
      throw error;
    } finally {
      if (this.speechAbortController === abortController) this.speechAbortController = undefined;
    }
  }

  stopSpeaking(): void {
    this.speakGeneration += 1;
    this.speechAbortController?.abort();
    this.speechAbortController = undefined;
    if (this.activeTts && !this.activeTts.killed) this.activeTts.kill("SIGTERM");
    this.activeTts = undefined;
  }

  private async speakHostedChunks(chunks: SpeechChunk[], generation: number, signal: AbortSignal): Promise<boolean> {
    if (chunks.length === 0) return false;
    let wavPromise = this.synthesize(chunks[0]!.text, signal);
    void wavPromise.catch(() => undefined);

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      const wav = await wavPromise;
      if (generation !== this.speakGeneration) return false;

      const next = chunks[index + 1];
      if (next) {
        wavPromise = this.synthesize(next.text, signal);
        void wavPromise.catch(() => undefined);
      }

      await this.playWav(wav, generation);
      if (generation !== this.speakGeneration) return false;
      if (chunk.pauseSeconds > 0) await sleep(chunk.pauseSeconds * 1000, undefined, { signal });
    }

    return true;
  }

  private async speakPocketChunks(chunks: SpeechChunk[], generation: number, signal: AbortSignal): Promise<boolean> {
    for (const chunk of chunks) {
      if (generation !== this.speakGeneration) return false;
      const response = await this.requestPocketSpeech(chunk.text, signal);
      if (generation !== this.speakGeneration) return false;
      await this.playWavStream(response, generation, signal);
      if (generation !== this.speakGeneration) return false;
      if (chunk.pauseSeconds > 0) await sleep(chunk.pauseSeconds * 1000, undefined, { signal });
    }
    return chunks.length > 0;
  }

  private onRecorderData(chunk: Buffer, generation: number): void {
    if (generation !== this.lifecycleGeneration) return;
    this.recorderCarry = Buffer.concat([this.recorderCarry, chunk]);
    const frameBytes = this.vad.getFrameBytes();
    while (this.recorderCarry.length >= frameBytes) {
      const frame = this.recorderCarry.subarray(0, frameBytes);
      this.recorderCarry = this.recorderCarry.subarray(frameBytes);
      for (const emission of this.vad.pushFrame(frame)) this.runVadEmission(emission, generation);
    }
  }

  private runVadEmission(emission: VadEmission, generation: number): void {
    const task = this.handleVadEmission(emission, generation);
    this.pendingVadTasks.add(task);
    void task.catch((error: unknown) => {
      if (generation === this.lifecycleGeneration) {
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
      }
    }).finally(() => this.pendingVadTasks.delete(task));
  }

  private async handleVadEmission(emission: VadEmission, generation: number): Promise<void> {
    if (generation !== this.lifecycleGeneration) return;
    if (emission.type === "barge-in") {
      this.stopSpeaking();
      this.emit("barge-in");
      return;
    }
    if (emission.type === "speech-start") return;
    const text = await this.transcribe(emission.audio);
    if (generation !== this.lifecycleGeneration) return;
    if (!text) {
      this.emit("diagnostic", `[transcription.dropped id=${emission.utteranceId} final=${emission.type === "final"}] empty text, nothing emitted`);
      return;
    }
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
    if (this.config.sttProvider === "moonshine") {
      const moonshine = await this.ensureMoonshine();
      return moonshine.transcribe(audio, this.config.sampleRate, this.config.channels);
    }

    const wav = encodeWav(audio, this.config.sampleRate, this.config.channels, this.config.bytesPerSample);
    const seconds = audio.length / (this.config.sampleRate * this.config.channels * this.config.bytesPerSample);
    const frames = Math.floor((seconds * 1000) / this.config.frameDurationMs);
    const timeoutMs = computeSttTimeoutMs(audio.length, this.config);
    const detail = `bytes=${audio.length} seconds=${seconds.toFixed(1)} frames=${frames} timeout=${timeoutMs}ms`;
    let errorRetriesLeft = this.config.sttErrorRetries;
    // Only anomalous empties are retried: a genuinely-silent short segment must not spam retries.
    let emptyRetriesLeft = frames >= this.config.vadMinUtteranceFrames ? this.config.sttEmptyTextRetries : 0;
    for (;;) {
      try {
        const text = await this.requestTranscription(wav, timeoutMs);
        if (text) return text;
        this.emit("diagnostic", `[stt] empty text from 200 response (${detail} retriesLeft=${emptyRetriesLeft})`);
        if (emptyRetriesLeft <= 0) return "";
        emptyRetriesLeft -= 1;
        await sleep(300);
      } catch (error) {
        if (!isRetryableSttError(error) || errorRetriesLeft <= 0) throw error;
        errorRetriesLeft -= 1;
        this.emit("diagnostic", `[stt] transcription request failed, retrying (${detail}): ${String(error)}`);
      }
    }
  }

  private async requestTranscription(wav: Buffer, timeoutMs: number): Promise<string> {
    const form = new FormData();
    form.set("model", this.config.whisperModel);
    form.set("response_format", "json");
    form.set("language", this.config.whisperLanguage);
    if (this.config.whisperPrompt) form.set("prompt", this.config.whisperPrompt);
    form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
    const controller = new AbortController();
    this.transcriptionAbortControllers.add(controller);
    try {
      const response = await fetch(this.config.whisperUrl, {
        method: "POST",
        headers: this.apiHeaders("transcription"),
        body: form,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
      });
      if (!response.ok) throw await this.requestError("transcription", response);
      const payload = (await response.json()) as { text?: string };
      return payload.text?.trim() ?? "";
    } finally {
      this.transcriptionAbortControllers.delete(controller);
    }
  }

  private async synthesize(text: string, signal?: AbortSignal): Promise<Buffer> {
    if (this.config.ttsProvider === "pocket-tts") {
      const response = await this.requestPocketSpeech(text, signal);
      return Buffer.from(await response.arrayBuffer());
    }

    const timeoutSignal = AbortSignal.timeout(this.config.apiTimeoutMs);
    const response = await fetch(this.config.kokoroUrl, {
      method: "POST",
      headers: this.apiHeaders("speech", "application/json"),
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      body: JSON.stringify({
        model: this.config.kokoroModel,
        input: text,
        voice: this.config.kokoroVoice,
        response_format: "wav",
        ...(this.config.ttsProvider === "openai" || this.config.ttsProvider === "piper" || this.config.ttsProvider === "speaches-kokoro"
          ? { speed: this.config.ttsSpeed }
          : {}),
      }),
    });
    if (!response.ok) throw await this.requestError("speech", response);
    return Buffer.from(await response.arrayBuffer());
  }

  private async requestPocketSpeech(text: string, signal?: AbortSignal): Promise<Response> {
    const form = new FormData();
    form.set("text", text);
    form.set("voice_url", this.config.kokoroVoice);
    const timeoutSignal = AbortSignal.timeout(this.config.apiTimeoutMs);
    const response = await fetch(this.config.kokoroUrl, {
      method: "POST",
      body: form,
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    });
    if (!response.ok) throw await this.requestError("speech", response);
    return response;
  }

  private apiHeaders(operation: "transcription" | "speech", contentType?: string): Headers {
    const headers = new Headers();
    if (contentType) headers.set("content-type", contentType);
    const apiKey = operation === "transcription" ? this.config.sttApiKey : this.config.ttsApiKey;
    if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
    return headers;
  }

  private async requestError(operation: "transcription" | "speech", response: Response): Promise<Error> {
    const provider = operation === "transcription" ? this.config.sttProvider : this.config.ttsProvider;
    const backend = provider === "openai"
      ? "OpenAI"
      : provider === "groq"
        ? "Groq"
        : provider === "speaches"
          ? "Speaches"
          : provider === "whisper.cpp"
            ? "whisper.cpp"
            : provider === "kokoro"
              ? "Kokoro"
              : provider === "speaches-kokoro"
                ? "Speaches Kokoro ONNX"
                : provider === "piper"
                  ? "Speaches Piper"
                  : provider === "pocket-tts"
                    ? "Pocket TTS"
                    : operation === "transcription"
                ? "Whisper"
                : "Kokoro";
    const detail = (await response.text()).trim().replace(/\s+/g, " ").slice(0, 500);
    return new Error(`${backend} ${operation} request failed: ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  private async ensureMoonshine(): Promise<MoonshineClient> {
    if (!this.moonshine) {
      this.moonshine = new MoonshineClient({
        pythonCommand: this.config.moonshinePythonCommand,
        sidecarPath: this.config.moonshineSidecarPath,
        language: this.config.moonshineLanguage,
        model: this.config.moonshineModel,
        timeoutMs: this.config.apiTimeoutMs,
      }, (error) => this.emit("error", error));
    }
    await this.moonshine.start();
    return this.moonshine;
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

  private async playWavStream(response: Response, generation: number, signal: AbortSignal): Promise<void> {
    if (!response.body) throw new Error("Pocket TTS speech response had no audio stream");
    const command = this.config.playerCommand.split("/").pop() ?? this.config.playerCommand;
    const args = command === "paplay"
      ? [...this.config.playerAdditionalArgs]
      : ["-q", ...this.config.playerAdditionalArgs, "-"];
    const child = spawn(this.config.playerCommand, args, { stdio: ["pipe", "ignore", "pipe"] });
    this.activeTts = child;
    child.stderr.on("data", () => undefined);
    child.stdin.on("error", () => undefined);
    const closed = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, childSignal) => {
        if (this.activeTts === child) this.activeTts = undefined;
        if (generation !== this.speakGeneration || childSignal === "SIGTERM") {
          resolve();
          return;
        }
        if (code === 0) resolve();
        else reject(new Error(`Player exited unexpectedly: code=${code} signal=${childSignal}`));
      });
    });
    void closed.catch(() => undefined);

    const reader = response.body.getReader();
    let completed = false;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (!child.stdin.write(next.value)) await once(child.stdin, "drain", { signal });
      }
      child.stdin.end();
      await closed;
      completed = true;
    } finally {
      if (!completed) {
        await reader.cancel().catch(() => undefined);
        if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
      }
      if (this.activeTts === child) this.activeTts = undefined;
      reader.releaseLock();
    }
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
