import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfigPath, loadConfig } from "./config.js";

const missingConfigPath = join(tmpdir(), "claude-converse-test-missing", "config.json");
const loadEnvConfig = () => loadConfig(missingConfigPath);

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
    const config = loadEnvConfig();
    expect(config.port).toBe(45839);
    expect(config.vadBargeInEnergyMultiplier).toBe(2);
    expect(config.vadUtteranceEndFrames).toBe(60);
  });

  it("rejects unsupported bytes-per-sample values", () => {
    process.env.CONVERSE_BYTES_PER_SAMPLE = "4";
    expect(() => loadEnvConfig()).toThrow(/unsupported/);
  });

  it("automatically uses OpenAI when its API key is available", () => {
    process.env.OPENAI_API_KEY = "test-key";

    const config = loadEnvConfig();

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

    expect(loadEnvConfig().kokoroVoice).toBe("marin");
  });

  it("permits opting out of OpenAI and retaining the local defaults", () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.CONVERSE_VOICE_PROVIDER = "local";

    const config = loadEnvConfig();

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
    expect(() => loadEnvConfig()).toThrow(/apiKey/);
  });

  it("does not send the OpenAI key to a URL override", () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.WHISPER_URL = "http://localhost:2022/v1/audio/transcriptions";
    expect(() => loadEnvConfig()).toThrow(/must use https:\/\/api\.openai\.com/);
  });

  it("rejects non-positive API timeouts", () => {
    process.env.CONVERSE_API_TIMEOUT_MS = "0";
    expect(() => loadEnvConfig()).toThrow(/positive number/);
  });

  it("rejects unsupported speech speeds", () => {
    process.env.CONVERSE_TTS_SPEED = "4.1";
    expect(() => loadEnvConfig()).toThrow(/between 0.25 and 4/);
  });

  it("loads explicit file settings ahead of environment fallbacks", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-converse-config-"));
    const path = join(directory, "config.json");
    process.env.CONVERSE_PORT = "1000";
    process.env.OPENAI_API_KEY = "environment-key";
    writeFileSync(path, JSON.stringify({
      voiceProvider: "local",
      apiKey: "file-key",
      port: 2345,
      sampleRate: 48_000,
      recorderAdditionalArgs: ["--raw", "--verbose"],
      statusPrefix: "voice: ",
      kokoroVoice: "af_sky",
    }));

    expect(loadConfig(path)).toMatchObject({
      voiceProvider: "local",
      apiKey: undefined,
      port: 2345,
      sampleRate: 48_000,
      recorderAdditionalArgs: ["--raw", "--verbose"],
      statusPrefix: "voice: ",
      kokoroVoice: "af_sky",
    });
    rmSync(directory, { recursive: true, force: true });
  });

  it("accepts a complete OpenAI configuration without environment variables", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-converse-config-"));
    const path = join(directory, "config.json");
    writeFileSync(path, JSON.stringify({ voiceProvider: "openai", apiKey: "file-key", ttsSpeed: 1.5 }));

    expect(loadConfig(path)).toMatchObject({
      voiceProvider: "openai",
      apiKey: "file-key",
      whisperModel: "gpt-4o-transcribe",
      kokoroModel: "gpt-4o-mini-tts",
      ttsSpeed: 1.5,
    });
    rmSync(directory, { recursive: true, force: true });
  });

  it("reports malformed, unknown, and incorrectly typed file settings", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-converse-config-"));
    const path = join(directory, "config.json");

    writeFileSync(path, "{");
    expect(() => loadConfig(path)).toThrow(/Invalid JSON.*config\.json/);
    writeFileSync(path, JSON.stringify({ typoSetting: true }));
    expect(() => loadConfig(path)).toThrow(/Unknown.*typoSetting/);
    writeFileSync(path, JSON.stringify({ port: "45839" }));
    expect(() => loadConfig(path)).toThrow(/port.*must be number/);
    rmSync(directory, { recursive: true, force: true });
  });

  it("uses the XDG configuration directory by default", () => {
    const original = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = "/tmp/test-xdg";
    expect(defaultConfigPath()).toBe("/tmp/test-xdg/claude-converse/config.json");
    if (original === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = original;
  });

});
