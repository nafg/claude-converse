import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const configEnv = [
  "CONVERSE_PORT",
  "VAD_BARGE_IN_ENERGY_MULT",
  "CONVERSE_BYTES_PER_SAMPLE",
  "CONVERSE_VOICE_PROVIDER",
  "CONVERSE_API_TIMEOUT_MS",
  "CONVERSE_TTS_SPEED",
  "CONVERSE_TTS_VOICE",
  "CONVERSE_VOICE_WAIT_MS",
  "OPENAI_API_KEY",
  "WHISPER_URL",
  "WHISPER_MODEL",
  "KOKORO_URL",
  "KOKORO_VOICE",
  "KOKORO_MODEL",
] as const;

const originalEnv = new Map(configEnv.map((name) => [name, process.env[name]]));

beforeEach(() => {
  for (const name of configEnv) delete process.env[name];
});

afterEach(() => {
  for (const name of configEnv) {
    const value = originalEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("loadConfig", () => {
  it("falls back on invalid numeric env vars", () => {
    process.env.CONVERSE_PORT = "abc";
    process.env.VAD_BARGE_IN_ENERGY_MULT = "nan";
    const config = loadConfig();
    expect(config.port).toBe(45839);
    expect(config.vadBargeInEnergyMultiplier).toBe(2);
    expect(config.vadUtteranceEndFrames).toBe(60);
  });

  it("rejects unsupported bytes-per-sample values", () => {
    process.env.CONVERSE_BYTES_PER_SAMPLE = "4";
    expect(() => loadConfig()).toThrow(/unsupported/);
  });

  it("automatically uses OpenAI when its API key is available", () => {
    process.env.OPENAI_API_KEY = "test-key";

    const config = loadConfig();

    expect(config).toMatchObject({
      voiceProvider: "openai",
      apiKey: "test-key",
      apiTimeoutMs: 60_000,
      ttsSpeed: 1.25,
      voiceWaitMs: 5_000,
      whisperUrl: "https://api.openai.com/v1/audio/transcriptions",
      whisperModel: "gpt-4o-transcribe",
      kokoroUrl: "https://api.openai.com/v1/audio/speech",
      kokoroVoice: "alloy",
      kokoroModel: "gpt-4o-mini-tts",
    });
  });

  it("uses the provider-neutral TTS voice override", () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.CONVERSE_TTS_VOICE = "marin";
    process.env.KOKORO_VOICE = "legacy-voice";

    expect(loadConfig().kokoroVoice).toBe("marin");
  });

  it("permits opting out of OpenAI and retaining the local defaults", () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.CONVERSE_VOICE_PROVIDER = "local";

    const config = loadConfig();

    expect(config).toMatchObject({
      voiceProvider: "local",
      apiKey: undefined,
      whisperUrl: "http://localhost:2022/v1/audio/transcriptions",
      whisperModel: "base",
      kokoroUrl: "http://localhost:8880/v1/audio/speech",
      kokoroVoice: "af_heart",
      kokoroModel: "kokoro",
    });
  });

  it("requires a key when OpenAI is explicitly selected", () => {
    process.env.CONVERSE_VOICE_PROVIDER = "openai";
    expect(() => loadConfig()).toThrow(/OPENAI_API_KEY/);
  });

  it("does not send the OpenAI key to a URL override", () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.WHISPER_URL = "http://localhost:2022/v1/audio/transcriptions";
    expect(() => loadConfig()).toThrow(/must use https:\/\/api\.openai\.com/);
  });

  it("rejects non-positive API timeouts", () => {
    process.env.CONVERSE_API_TIMEOUT_MS = "0";
    expect(() => loadConfig()).toThrow(/positive integer/);
  });

  it("rejects unsupported speech speeds", () => {
    process.env.CONVERSE_TTS_SPEED = "4.1";
    expect(() => loadConfig()).toThrow(/between 0.25 and 4/);
  });
});
