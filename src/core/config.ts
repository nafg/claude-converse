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
  voiceProvider: "local" | "openai";
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
  recorderCommand: string;
  recorderDevice: string;
  recorderAdditionalArgs: string[];
  playerCommand: string;
  playerAdditionalArgs: string[];
  host: string;
  port: number;
}

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
  if (!value) return [];
  return value.split(/\s+/g);
};

const voiceProvider = (): "local" | "openai" => {
  const configured = process.env.CONVERSE_VOICE_PROVIDER?.trim().toLowerCase();
  if (!configured) return process.env.OPENAI_API_KEY?.trim() ? "openai" : "local";
  if (configured === "local" || configured === "openai") return configured;
  throw new Error(`CONVERSE_VOICE_PROVIDER=${configured} is unsupported; use local or openai`);
};

const isOpenAiUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "api.openai.com";
  } catch {
    return false;
  }
};

export const loadConfig = (): ConverseConfig => {
  const bytesPerSample = intEnv("CONVERSE_BYTES_PER_SAMPLE", 2);
  if (bytesPerSample !== 2) {
    throw new Error(`CONVERSE_BYTES_PER_SAMPLE=${bytesPerSample} is unsupported; only 2-byte S16_LE audio is supported`);
  }

  const provider = voiceProvider();
  const apiKey = provider === "openai" ? process.env.OPENAI_API_KEY?.trim() : undefined;
  if (provider === "openai" && !apiKey) {
    throw new Error("OPENAI_API_KEY must be set when CONVERSE_VOICE_PROVIDER=openai");
  }
  const apiTimeoutMs = intEnv("CONVERSE_API_TIMEOUT_MS", 60_000);
  if (apiTimeoutMs <= 0) {
    throw new Error("CONVERSE_API_TIMEOUT_MS must be a positive integer");
  }
  const ttsSpeed = floatEnv("CONVERSE_TTS_SPEED", 1.25);
  if (ttsSpeed < 0.25 || ttsSpeed > 4) {
    throw new Error("CONVERSE_TTS_SPEED must be between 0.25 and 4");
  }
  const whisperUrl = process.env.WHISPER_URL ?? (provider === "openai" ? "https://api.openai.com/v1/audio/transcriptions" : "http://localhost:2022/v1/audio/transcriptions");
  const kokoroUrl = process.env.KOKORO_URL ?? (provider === "openai" ? "https://api.openai.com/v1/audio/speech" : "http://localhost:8880/v1/audio/speech");
  if (provider === "openai" && (!isOpenAiUrl(whisperUrl) || !isOpenAiUrl(kokoroUrl))) {
    throw new Error("WHISPER_URL and KOKORO_URL must use https://api.openai.com when CONVERSE_VOICE_PROVIDER=openai");
  }

  return {
  sampleRate: intEnv("CONVERSE_SAMPLE_RATE", 16_000),
  channels: intEnv("CONVERSE_CHANNELS", 1),
  bytesPerSample,
  frameDurationMs: intEnv("CONVERSE_FRAME_DURATION_MS", 30),
  vadThreshold: intEnv("VAD_THRESHOLD", 300),
  vadSpeechStartFrames: intEnv("VAD_SPEECH_START_FRAMES", 3),
  vadChunkSilenceFrames: intEnv("VAD_CHUNK_SILENCE_FRAMES", 20),
  vadUtteranceEndFrames: intEnv("VAD_UTTERANCE_END_FRAMES", 60),
  vadMinUtteranceFrames: intEnv("VAD_MIN_UTTERANCE_FRAMES", 10),
  vadBargeInEnergyMultiplier: floatEnv("VAD_BARGE_IN_ENERGY_MULT", 2.0),
  vadBargeInFrames: intEnv("VAD_BARGE_IN_FRAMES", 6),
  vadPreBufferFrames: intEnv("VAD_PRE_BUFFER_FRAMES", 10),
  recentMaxEntries: intEnv("RECENT_MAX_ENTRIES", 50),
  statusWindowSeconds: intEnv("CONVERSE_STATUS_WINDOW", 30),
  statusPrefix: process.env.CONVERSE_STATUS_PREFIX ?? "🎤 ",
  statusSeparator: process.env.CONVERSE_STATUS_SEPARATOR ?? " | ",
  voiceProvider: provider,
  apiKey,
  apiTimeoutMs,
  whisperUrl,
  whisperModel: process.env.WHISPER_MODEL ?? (provider === "openai" ? "gpt-4o-transcribe" : "base"),
  whisperLanguage: process.env.WHISPER_LANGUAGE ?? "en",
  whisperPrompt: process.env.WHISPER_INITIAL_PROMPT ?? "",
  kokoroUrl,
  kokoroVoice: process.env.KOKORO_VOICE ?? (provider === "openai" ? "alloy" : "af_heart"),
  kokoroModel: process.env.KOKORO_MODEL ?? (provider === "openai" ? "gpt-4o-mini-tts" : "kokoro"),
  ttsSpeed,
  recorderCommand: process.env.CONVERSE_RECORDER_COMMAND ?? "parecord",
  recorderDevice: process.env.CONVERSE_RECORDER_DEVICE ?? "default",
  recorderAdditionalArgs: stringListEnv("CONVERSE_RECORDER_ARGS"),
  playerCommand: process.env.CONVERSE_PLAYER_COMMAND ?? "paplay",
  playerAdditionalArgs: stringListEnv("CONVERSE_PLAYER_ARGS"),
  host: process.env.CONVERSE_HOST ?? "127.0.0.1",
  port: intEnv("CONVERSE_PORT", 45839),
};
};
