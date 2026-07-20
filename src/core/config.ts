import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ConverseConfig {
  sampleRate: number;
  channels: number;
  bytesPerSample: number;
  frameDurationMs: number;
  vadThreshold: number;
  vadSpeechStartFrames: number;
  vadChunkSilenceFrames: number;
  vadUtteranceEndFrames: number;
  vadMinUtteranceFrames: number;
  vadBargeInEnergyMultiplier: number;
  vadBargeInFrames: number;
  vadPreBufferFrames: number;
  recentMaxEntries: number;
  statusWindowSeconds: number;
  statusPrefix: string;
  statusSeparator: string;
  sttProvider: SttProvider;
  ttsProvider: TtsProvider;
  sttApiKey?: string;
  ttsApiKey?: string;
  /** Compatibility summary for callers that used the formerly coupled provider. */
  voiceProvider: "local" | "openai" | "mixed";
  /** Compatibility key populated only when both sides use the same OpenAI key. */
  apiKey?: string;
  apiTimeoutMs: number;
  whisperUrl: string;
  whisperModel: string;
  whisperLanguage: string;
  whisperPrompt: string;
  kokoroUrl: string;
  kokoroVoice: string;
  kokoroModel: string;
  ttsSpeed: number;
  voiceWaitMs: number;
  recorderCommand: string;
  recorderDevice: string;
  recorderAdditionalArgs: string[];
  playerCommand: string;
  playerAdditionalArgs: string[];
  host: string;
  port: number;
}

export type SttProvider = "local" | "openai" | "groq" | "whisper.cpp";
export type TtsProvider = "local" | "openai" | "kokoro";
type LegacyAudioProvider = "local" | "openai";
type FileConfig = Partial<Omit<ConverseConfig, "voiceProvider" | "apiKey">> & {
  voiceProvider?: LegacyAudioProvider;
  apiKey?: string;
};
type ValueKind = "number" | "string" | "string[]" | "stt-provider" | "tts-provider" | "legacy-provider";

const fileConfigKinds: Record<keyof ConverseConfig, ValueKind> = {
  sampleRate: "number",
  channels: "number",
  bytesPerSample: "number",
  frameDurationMs: "number",
  vadThreshold: "number",
  vadSpeechStartFrames: "number",
  vadChunkSilenceFrames: "number",
  vadUtteranceEndFrames: "number",
  vadMinUtteranceFrames: "number",
  vadBargeInEnergyMultiplier: "number",
  vadBargeInFrames: "number",
  vadPreBufferFrames: "number",
  recentMaxEntries: "number",
  statusWindowSeconds: "number",
  statusPrefix: "string",
  statusSeparator: "string",
  sttProvider: "stt-provider",
  ttsProvider: "tts-provider",
  sttApiKey: "string",
  ttsApiKey: "string",
  voiceProvider: "legacy-provider",
  apiKey: "string",
  apiTimeoutMs: "number",
  whisperUrl: "string",
  whisperModel: "string",
  whisperLanguage: "string",
  whisperPrompt: "string",
  kokoroUrl: "string",
  kokoroVoice: "string",
  kokoroModel: "string",
  ttsSpeed: "number",
  voiceWaitMs: "number",
  recorderCommand: "string",
  recorderDevice: "string",
  recorderAdditionalArgs: "string[]",
  playerCommand: "string",
  playerAdditionalArgs: "string[]",
  host: "string",
  port: "number",
};

export const defaultConfigPath = (): string =>
  join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "claude-converse", "config.json");

const readFileConfig = (path: string): FileConfig => {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read Converse config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in Converse config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Converse config ${path} must contain a JSON object`);
  }

  const config = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(config)) {
    const kind = fileConfigKinds[key as keyof ConverseConfig];
    if (!kind) throw new Error(`Unknown Converse config setting ${key} in ${path}`);
    const valid = kind === "string[]"
      ? Array.isArray(item) && item.every((entry) => typeof entry === "string")
      : kind === "stt-provider"
        ? item === "local" || item === "openai" || item === "groq" || item === "whisper.cpp"
        : kind === "tts-provider"
          ? item === "local" || item === "openai" || item === "kokoro"
          : kind === "legacy-provider"
            ? item === "local" || item === "openai"
            : typeof item === kind && (kind !== "number" || Number.isFinite(item));
    if (!valid) throw new Error(`Converse config setting ${key} in ${path} must be ${kind}`);
  }
  return config as FileConfig;
};

const intEnv = (name: string, fallback: number): number => {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const floatEnv = (name: string, fallback: number): number => {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const stringListEnv = (name: string): string[] => {
  const value = process.env[name]?.trim();
  return value ? value.split(/\s+/g) : [];
};

const legacyProviderEnv = (name: string): LegacyAudioProvider | undefined => {
  const configured = process.env[name]?.trim().toLowerCase();
  if (!configured) return undefined;
  if (configured === "local" || configured === "openai") return configured;
  throw new Error(`${name}=${configured} is unsupported; use local or openai`);
};

const sttProviderEnv = (): SttProvider | undefined => {
  const configured = process.env.CONVERSE_STT_PROVIDER?.trim().toLowerCase();
  if (!configured) return undefined;
  if (configured === "local" || configured === "openai" || configured === "groq" || configured === "whisper.cpp") return configured;
  throw new Error(`CONVERSE_STT_PROVIDER=${configured} is unsupported; use local, whisper.cpp, groq, or openai`);
};

const ttsProviderEnv = (): TtsProvider | undefined => {
  const configured = process.env.CONVERSE_TTS_PROVIDER?.trim().toLowerCase();
  if (!configured) return undefined;
  if (configured === "local" || configured === "openai" || configured === "kokoro") return configured;
  throw new Error(`CONVERSE_TTS_PROVIDER=${configured} is unsupported; use local, kokoro, or openai`);
};

const legacyVoiceProvider = (): LegacyAudioProvider =>
  legacyProviderEnv("CONVERSE_VOICE_PROVIDER") ?? (process.env.OPENAI_API_KEY?.trim() ? "openai" : "local");

const isOpenAiUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "api.openai.com";
  } catch {
    return false;
  }
};

const isGroqTranscriptionUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "api.groq.com"
      && url.pathname === "/openai/v1/audio/transcriptions"
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
};

export const loadConfig = (path = defaultConfigPath()): ConverseConfig => {
  const file = readFileConfig(path);
  const environmentProvider = legacyVoiceProvider();
  const sttProvider = file.sttProvider ?? file.voiceProvider ?? sttProviderEnv() ?? environmentProvider;
  const ttsProvider = file.ttsProvider ?? file.voiceProvider ?? ttsProviderEnv() ?? environmentProvider;
  const environmentApiKey = process.env.OPENAI_API_KEY?.trim();
  const sttApiKey = sttProvider === "openai"
    ? file.sttApiKey ?? file.apiKey ?? process.env.OPENAI_STT_API_KEY?.trim() ?? environmentApiKey
    : sttProvider === "groq"
      ? file.sttApiKey
      : undefined;
  const ttsApiKey = ttsProvider === "openai"
    ? file.ttsApiKey ?? file.apiKey ?? process.env.OPENAI_TTS_API_KEY?.trim() ?? environmentApiKey
    : undefined;
  const bytesPerSample = file.bytesPerSample ?? intEnv("CONVERSE_BYTES_PER_SAMPLE", 2);
  const apiTimeoutMs = file.apiTimeoutMs ?? intEnv("CONVERSE_API_TIMEOUT_MS", 60_000);
  const ttsSpeed = file.ttsSpeed ?? floatEnv("CONVERSE_TTS_SPEED", 1.25);
  const voiceWaitMs = file.voiceWaitMs ?? intEnv("CONVERSE_VOICE_WAIT_MS", 5_000);
  const whisperUrl = file.whisperUrl ?? process.env.WHISPER_URL ?? (sttProvider === "openai"
    ? "https://api.openai.com/v1/audio/transcriptions"
    : sttProvider === "groq"
      ? "https://api.groq.com/openai/v1/audio/transcriptions"
      : "http://localhost:2022/v1/audio/transcriptions");
  const kokoroUrl = file.kokoroUrl ?? process.env.KOKORO_URL ?? (ttsProvider === "openai" ? "https://api.openai.com/v1/audio/speech" : "http://localhost:8880/v1/audio/speech");

  if (bytesPerSample !== 2) throw new Error(`bytesPerSample=${bytesPerSample} is unsupported; only 2-byte S16_LE audio is supported`);
  if ((sttProvider === "openai" || sttProvider === "groq") && !sttApiKey) {
    throw new Error(`sttApiKey must be set in ${path} when sttProvider is ${sttProvider}`);
  }
  if (ttsProvider === "openai" && !ttsApiKey) throw new Error(`ttsApiKey must be set in ${path} when ttsProvider is openai`);
  if (apiTimeoutMs <= 0) throw new Error("apiTimeoutMs must be a positive number");
  if (ttsSpeed < 0.25 || ttsSpeed > 4) throw new Error("ttsSpeed must be between 0.25 and 4");
  if (voiceWaitMs <= 0) throw new Error("voiceWaitMs must be a positive number");
  if (sttProvider === "openai" && !isOpenAiUrl(whisperUrl)) {
    throw new Error("whisperUrl must use https://api.openai.com when sttProvider is openai");
  }
  if (sttProvider === "groq" && !isGroqTranscriptionUrl(whisperUrl)) {
    throw new Error("whisperUrl must use https://api.groq.com/openai/v1/audio/transcriptions when sttProvider is groq");
  }
  if (ttsProvider === "openai" && !isOpenAiUrl(kokoroUrl)) {
    throw new Error("kokoroUrl must use https://api.openai.com when ttsProvider is openai");
  }

  const voiceProvider = sttProvider === "openai" && ttsProvider === "openai"
    ? "openai"
    : sttProvider !== "openai" && ttsProvider !== "openai"
      ? "local"
      : "mixed";
  const apiKey = sttProvider === "openai" && ttsProvider === "openai" && sttApiKey === ttsApiKey ? sttApiKey : undefined;

  return {
    sampleRate: file.sampleRate ?? intEnv("CONVERSE_SAMPLE_RATE", 16_000),
    channels: file.channels ?? intEnv("CONVERSE_CHANNELS", 1),
    bytesPerSample,
    frameDurationMs: file.frameDurationMs ?? intEnv("CONVERSE_FRAME_DURATION_MS", 30),
    vadThreshold: file.vadThreshold ?? intEnv("VAD_THRESHOLD", 300),
    vadSpeechStartFrames: file.vadSpeechStartFrames ?? intEnv("VAD_SPEECH_START_FRAMES", 3),
    vadChunkSilenceFrames: file.vadChunkSilenceFrames ?? intEnv("VAD_CHUNK_SILENCE_FRAMES", 20),
    vadUtteranceEndFrames: file.vadUtteranceEndFrames ?? intEnv("VAD_UTTERANCE_END_FRAMES", 60),
    vadMinUtteranceFrames: file.vadMinUtteranceFrames ?? intEnv("VAD_MIN_UTTERANCE_FRAMES", 10),
    vadBargeInEnergyMultiplier: file.vadBargeInEnergyMultiplier ?? floatEnv("VAD_BARGE_IN_ENERGY_MULT", 2.0),
    vadBargeInFrames: file.vadBargeInFrames ?? intEnv("VAD_BARGE_IN_FRAMES", 6),
    vadPreBufferFrames: file.vadPreBufferFrames ?? intEnv("VAD_PRE_BUFFER_FRAMES", 10),
    recentMaxEntries: file.recentMaxEntries ?? intEnv("RECENT_MAX_ENTRIES", 50),
    statusWindowSeconds: file.statusWindowSeconds ?? intEnv("CONVERSE_STATUS_WINDOW", 30),
    statusPrefix: file.statusPrefix ?? process.env.CONVERSE_STATUS_PREFIX ?? "🎤 ",
    statusSeparator: file.statusSeparator ?? process.env.CONVERSE_STATUS_SEPARATOR ?? " | ",
    sttProvider,
    ttsProvider,
    sttApiKey,
    ttsApiKey,
    voiceProvider,
    apiKey,
    apiTimeoutMs,
    whisperUrl,
    whisperModel: file.whisperModel ?? process.env.WHISPER_MODEL ?? (sttProvider === "openai"
      ? "gpt-4o-transcribe"
      : sttProvider === "groq"
        ? "whisper-large-v3-turbo"
        : sttProvider === "whisper.cpp"
          ? "base.en"
          : "base"),
    whisperLanguage: file.whisperLanguage ?? process.env.WHISPER_LANGUAGE ?? "en",
    whisperPrompt: file.whisperPrompt ?? process.env.WHISPER_INITIAL_PROMPT ?? "",
    kokoroUrl,
    kokoroVoice: file.kokoroVoice ?? process.env.CONVERSE_TTS_VOICE ?? process.env.KOKORO_VOICE ?? (ttsProvider === "openai" ? "alloy" : "af_heart"),
    kokoroModel: file.kokoroModel ?? process.env.KOKORO_MODEL ?? (ttsProvider === "openai" ? "gpt-4o-mini-tts" : "kokoro"),
    ttsSpeed,
    voiceWaitMs,
    recorderCommand: file.recorderCommand ?? process.env.CONVERSE_RECORDER_COMMAND ?? "parecord",
    recorderDevice: file.recorderDevice ?? process.env.CONVERSE_RECORDER_DEVICE ?? "default",
    recorderAdditionalArgs: file.recorderAdditionalArgs ?? stringListEnv("CONVERSE_RECORDER_ARGS"),
    playerCommand: file.playerCommand ?? process.env.CONVERSE_PLAYER_COMMAND ?? "paplay",
    playerAdditionalArgs: file.playerAdditionalArgs ?? stringListEnv("CONVERSE_PLAYER_ARGS"),
    host: file.host ?? process.env.CONVERSE_HOST ?? "127.0.0.1",
    port: file.port ?? intEnv("CONVERSE_PORT", 45839),
  };
};
