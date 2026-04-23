const intEnv = (name, fallback) => {
    const value = process.env[name];
    return value ? Number.parseInt(value, 10) : fallback;
};
const floatEnv = (name, fallback) => {
    const value = process.env[name];
    return value ? Number.parseFloat(value) : fallback;
};
const stringListEnv = (name) => {
    const value = process.env[name]?.trim();
    if (!value)
        return [];
    return value.split(/\s+/g);
};
export const loadConfig = () => ({
    sampleRate: intEnv("CONVERSE_SAMPLE_RATE", 16_000),
    channels: intEnv("CONVERSE_CHANNELS", 1),
    bytesPerSample: intEnv("CONVERSE_BYTES_PER_SAMPLE", 2),
    frameDurationMs: intEnv("CONVERSE_FRAME_DURATION_MS", 30),
    vadThreshold: intEnv("VAD_THRESHOLD", 300),
    vadSpeechStartFrames: intEnv("VAD_SPEECH_START_FRAMES", 3),
    vadChunkSilenceFrames: intEnv("VAD_CHUNK_SILENCE_FRAMES", 20),
    vadUtteranceEndFrames: intEnv("VAD_UTTERANCE_END_FRAMES", 50),
    vadMinUtteranceFrames: intEnv("VAD_MIN_UTTERANCE_FRAMES", 10),
    vadBargeInEnergyMultiplier: floatEnv("VAD_BARGE_IN_ENERGY_MULT", 2.0),
    vadBargeInFrames: intEnv("VAD_BARGE_IN_FRAMES", 6),
    vadPreBufferFrames: intEnv("VAD_PRE_BUFFER_FRAMES", 10),
    recentMaxEntries: intEnv("RECENT_MAX_ENTRIES", 50),
    statusWindowSeconds: intEnv("CONVERSE_STATUS_WINDOW", 30),
    statusPrefix: process.env.CONVERSE_STATUS_PREFIX ?? "🎤 ",
    statusSeparator: process.env.CONVERSE_STATUS_SEPARATOR ?? " | ",
    whisperUrl: process.env.WHISPER_URL ?? "http://localhost:2022/v1/audio/transcriptions",
    whisperModel: process.env.WHISPER_MODEL ?? "base",
    whisperLanguage: process.env.WHISPER_LANGUAGE ?? "en",
    whisperPrompt: process.env.WHISPER_INITIAL_PROMPT ?? "",
    kokoroUrl: process.env.KOKORO_URL ?? "http://localhost:8880/v1/audio/speech",
    kokoroVoice: process.env.KOKORO_VOICE ?? "af_heart",
    kokoroModel: process.env.KOKORO_MODEL ?? "kokoro",
    recorderCommand: process.env.CONVERSE_RECORDER_COMMAND ?? "arecord",
    recorderDevice: process.env.CONVERSE_RECORDER_DEVICE ?? "default",
    recorderAdditionalArgs: stringListEnv("CONVERSE_RECORDER_ARGS"),
    playerCommand: process.env.CONVERSE_PLAYER_COMMAND ?? "aplay",
    playerAdditionalArgs: stringListEnv("CONVERSE_PLAYER_ARGS"),
    host: process.env.CONVERSE_HOST ?? "127.0.0.1",
    port: intEnv("CONVERSE_PORT", 45839),
});
