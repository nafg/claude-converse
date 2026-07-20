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
  "CONVERSE_STT_PROVIDER",
  "CONVERSE_TTS_PROVIDER",
  "CONVERSE_API_TIMEOUT_MS",
  "CONVERSE_TTS_SPEED",
  "CONVERSE_TTS_VOICE",
  "CONVERSE_VOICE_WAIT_MS",
  "OPENAI_API_KEY",
  "OPENAI_STT_API_KEY",
  "OPENAI_TTS_API_KEY",
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
      sttProvider: "openai",
      ttsProvider: "openai",
      voiceProvider: "openai",
      sttApiKey: "test-key",
      ttsApiKey: "test-key",
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
      sttProvider: "local",
      ttsProvider: "local",
      voiceProvider: "local",
      sttApiKey: undefined,
      ttsApiKey: undefined,
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
    expect(() => loadEnvConfig()).toThrow(/sttApiKey/);
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
      sttProvider: "local",
      ttsProvider: "local",
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
      sttProvider: "openai",
      ttsProvider: "openai",
      voiceProvider: "openai",
      sttApiKey: "file-key",
      ttsApiKey: "file-key",
      apiKey: "file-key",
      whisperModel: "gpt-4o-transcribe",
      kokoroModel: "gpt-4o-mini-tts",
      ttsSpeed: 1.5,
    });
    rmSync(directory, { recursive: true, force: true });
  });

  it("selects OpenAI independently for STT and TTS from the file", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-converse-config-"));
    const path = join(directory, "config.json");
    writeFileSync(path, JSON.stringify({
      sttProvider: "openai",
      ttsProvider: "local",
      sttApiKey: "stt-key",
    }));

    expect(loadConfig(path)).toMatchObject({
      sttProvider: "openai",
      ttsProvider: "local",
      voiceProvider: "mixed",
      sttApiKey: "stt-key",
      ttsApiKey: undefined,
      apiKey: undefined,
      whisperUrl: "https://api.openai.com/v1/audio/transcriptions",
      whisperModel: "gpt-4o-transcribe",
      kokoroUrl: "http://localhost:8880/v1/audio/speech",
      kokoroModel: "kokoro",
      kokoroVoice: "af_heart",
    });

    writeFileSync(path, JSON.stringify({
      sttProvider: "local",
      ttsProvider: "openai",
      ttsApiKey: "tts-key",
      ttsSpeed: 1.5,
    }));
    expect(loadConfig(path)).toMatchObject({
      sttProvider: "local",
      ttsProvider: "openai",
      voiceProvider: "mixed",
      sttApiKey: undefined,
      ttsApiKey: "tts-key",
      whisperUrl: "http://localhost:2022/v1/audio/transcriptions",
      whisperModel: "base",
      kokoroUrl: "https://api.openai.com/v1/audio/speech",
      kokoroModel: "gpt-4o-mini-tts",
      kokoroVoice: "alloy",
      ttsSpeed: 1.5,
    });
    rmSync(directory, { recursive: true, force: true });
  });

  it("validates only the OpenAI side's endpoint", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-converse-config-"));
    const path = join(directory, "config.json");
    writeFileSync(path, JSON.stringify({
      sttProvider: "openai",
      ttsProvider: "local",
      sttApiKey: "stt-key",
      whisperUrl: "https://example.com/v1/audio/transcriptions",
    }));
    expect(() => loadConfig(path)).toThrow(/whisperUrl.*api\.openai\.com/);

    writeFileSync(path, JSON.stringify({
      sttProvider: "local",
      ttsProvider: "openai",
      ttsApiKey: "tts-key",
      kokoroUrl: "http://localhost:8880/v1/audio/speech",
    }));
    expect(() => loadConfig(path)).toThrow(/kokoroUrl.*api\.openai\.com/);
    rmSync(directory, { recursive: true, force: true });
  });

  it("selects Kokoro explicitly with local defaults and no API key", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-converse-config-"));
    const path = join(directory, "config.json");
    writeFileSync(path, JSON.stringify({
      sttProvider: "whisper.cpp",
      ttsProvider: "kokoro",
      ttsApiKey: "must-not-be-used",
      kokoroUrl: "http://127.0.0.1:9999/v1/audio/speech",
      kokoroModel: "kokoro-v1",
      kokoroVoice: "af_sky",
    }));

    expect(loadConfig(path)).toMatchObject({
      sttProvider: "whisper.cpp",
      ttsProvider: "kokoro",
      voiceProvider: "local",
      ttsApiKey: undefined,
      kokoroUrl: "http://127.0.0.1:9999/v1/audio/speech",
      kokoroModel: "kokoro-v1",
      kokoroVoice: "af_sky",
    });

    writeFileSync(path, JSON.stringify({ sttProvider: "whisper.cpp", ttsProvider: "kokoro" }));
    expect(loadConfig(path)).toMatchObject({
      kokoroUrl: "http://localhost:8880/v1/audio/speech",
      kokoroModel: "kokoro",
      kokoroVoice: "af_heart",
    });
    rmSync(directory, { recursive: true, force: true });
  });

  it("selects Groq independently with hosted defaults and a file key", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-converse-config-"));
    const path = join(directory, "config.json");
    writeFileSync(path, JSON.stringify({
      sttProvider: "groq",
      sttApiKey: "groq-key",
      ttsProvider: "kokoro",
      ttsApiKey: "must-not-be-used",
    }));

    expect(loadConfig(path)).toMatchObject({
      sttProvider: "groq",
      ttsProvider: "kokoro",
      sttApiKey: "groq-key",
      ttsApiKey: undefined,
      whisperUrl: "https://api.groq.com/openai/v1/audio/transcriptions",
      whisperModel: "whisper-large-v3-turbo",
      whisperLanguage: "en",
      kokoroUrl: "http://localhost:8880/v1/audio/speech",
    });
    rmSync(directory, { recursive: true, force: true });
  });

  it("requires a Groq key and rejects every non-official transcription URL", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-converse-config-"));
    const path = join(directory, "config.json");

    writeFileSync(path, JSON.stringify({ sttProvider: "groq", ttsProvider: "local" }));
    expect(() => loadConfig(path)).toThrow(/sttApiKey.*groq/);

    for (const whisperUrl of [
      "http://api.groq.com/openai/v1/audio/transcriptions",
      "https://api.groq.com.evil.example/openai/v1/audio/transcriptions",
      "https://api.groq.com/openai/v1/chat/completions",
    ]) {
      writeFileSync(path, JSON.stringify({ sttProvider: "groq", sttApiKey: "groq-key", ttsProvider: "local", whisperUrl }));
      expect(() => loadConfig(path)).toThrow(/whisperUrl.*api\.groq\.com/);
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it("selects Speaches independently with documented defaults and optional loopback authentication", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-converse-config-"));
    const path = join(directory, "config.json");

    writeFileSync(path, JSON.stringify({ sttProvider: "speaches", ttsProvider: "kokoro" }));
    expect(loadConfig(path)).toMatchObject({
      sttProvider: "speaches",
      ttsProvider: "kokoro",
      voiceProvider: "local",
      sttApiKey: undefined,
      whisperUrl: "http://localhost:8000/v1/audio/transcriptions",
      whisperModel: "Systran/faster-distil-whisper-small.en",
      whisperLanguage: "en",
    });

    writeFileSync(path, JSON.stringify({
      sttProvider: "speaches",
      sttApiKey: "local-secret",
      ttsProvider: "kokoro",
      whisperUrl: "https://127.0.0.1:8443/v1/audio/transcriptions",
      whisperModel: "Systran/faster-whisper-small.en",
      whisperPrompt: "Programming terms",
    }));
    expect(loadConfig(path)).toMatchObject({
      sttProvider: "speaches",
      sttApiKey: "local-secret",
      whisperUrl: "https://127.0.0.1:8443/v1/audio/transcriptions",
      whisperModel: "Systran/faster-whisper-small.en",
      whisperPrompt: "Programming terms",
    });
    rmSync(directory, { recursive: true, force: true });
  });

  it("allows keyless custom Speaches endpoints but protects configured credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-converse-config-"));
    const path = join(directory, "config.json");

    writeFileSync(path, JSON.stringify({
      sttProvider: "speaches",
      ttsProvider: "local",
      whisperUrl: "http://speaches.lan:8000/v1/audio/transcriptions",
    }));
    expect(loadConfig(path).whisperUrl).toBe("http://speaches.lan:8000/v1/audio/transcriptions");

    for (const whisperUrl of [
      "http://speaches.lan:8000/v1/audio/transcriptions",
      "http://localhost:8000/not-transcription",
      "http://user:password@localhost:8000/v1/audio/transcriptions",
    ]) {
      writeFileSync(path, JSON.stringify({
        sttProvider: "speaches",
        sttApiKey: "local-secret",
        ttsProvider: "local",
        whisperUrl,
      }));
      expect(() => loadConfig(path)).toThrow(/whisperUrl|loopback/);
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it("selects Speaches Kokoro ONNX independently with documented defaults and optional loopback authentication", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-converse-config-"));
    const path = join(directory, "config.json");

    writeFileSync(path, JSON.stringify({ sttProvider: "whisper.cpp", ttsProvider: "speaches-kokoro" }));
    expect(loadConfig(path)).toMatchObject({
      sttProvider: "whisper.cpp",
      ttsProvider: "speaches-kokoro",
      voiceProvider: "local",
      ttsApiKey: undefined,
      kokoroUrl: "http://localhost:8000/v1/audio/speech",
      kokoroModel: "speaches-ai/Kokoro-82M-v1.0-ONNX",
      kokoroVoice: "af_heart",
      ttsSpeed: 1.25,
    });

    writeFileSync(path, JSON.stringify({
      sttProvider: "whisper.cpp",
      ttsProvider: "speaches-kokoro",
      ttsApiKey: "local-secret",
      kokoroUrl: "https://127.0.0.1:8443/v1/audio/speech",
      kokoroModel: "example/custom-kokoro-onnx",
      kokoroVoice: "af_sky",
      ttsSpeed: 1.5,
    }));
    expect(loadConfig(path)).toMatchObject({
      ttsProvider: "speaches-kokoro",
      ttsApiKey: "local-secret",
      kokoroUrl: "https://127.0.0.1:8443/v1/audio/speech",
      kokoroModel: "example/custom-kokoro-onnx",
      kokoroVoice: "af_sky",
      ttsSpeed: 1.5,
    });
    rmSync(directory, { recursive: true, force: true });
  });

  it("allows keyless custom Speaches speech endpoints but protects configured credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-converse-config-"));
    const path = join(directory, "config.json");

    writeFileSync(path, JSON.stringify({
      sttProvider: "whisper.cpp",
      ttsProvider: "speaches-kokoro",
      kokoroUrl: "http://speaches.lan:8000/v1/audio/speech",
    }));
    expect(loadConfig(path).kokoroUrl).toBe("http://speaches.lan:8000/v1/audio/speech");

    for (const kokoroUrl of [
      "http://speaches.lan:8000/v1/audio/speech",
      "http://localhost:8000/not-speech",
      "http://user:password@localhost:8000/v1/audio/speech",
    ]) {
      writeFileSync(path, JSON.stringify({
        sttProvider: "whisper.cpp",
        ttsProvider: "speaches-kokoro",
        ttsApiKey: "local-secret",
        kokoroUrl,
      }));
      expect(() => loadConfig(path)).toThrow(/kokoroUrl|loopback/);
    }

    writeFileSync(path, JSON.stringify({
      sttProvider: "whisper.cpp",
      ttsProvider: "speaches-kokoro",
      ttsSpeed: 2.1,
    }));
    expect(() => loadConfig(path)).toThrow(/ttsSpeed.*0\.5.*2/);
    rmSync(directory, { recursive: true, force: true });
  });

  it("selects Speaches Piper independently with verified US English defaults", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-converse-config-"));
    const path = join(directory, "config.json");

    writeFileSync(path, JSON.stringify({ sttProvider: "whisper.cpp", ttsProvider: "piper" }));
    expect(loadConfig(path)).toMatchObject({
      sttProvider: "whisper.cpp",
      ttsProvider: "piper",
      voiceProvider: "local",
      ttsApiKey: undefined,
      kokoroUrl: "http://localhost:8000/v1/audio/speech",
      kokoroModel: "speaches-ai/piper-en_US-lessac-medium",
      kokoroVoice: "lessac",
      ttsSpeed: 1.25,
    });

    writeFileSync(path, JSON.stringify({
      sttProvider: "whisper.cpp",
      ttsProvider: "piper",
      ttsApiKey: "local-secret",
      kokoroUrl: "https://127.0.0.1:8443/v1/audio/speech",
      kokoroModel: "speaches-ai/piper-en_US-ryan-high",
      kokoroVoice: "ryan",
      ttsSpeed: 1.5,
    }));
    expect(loadConfig(path)).toMatchObject({
      ttsProvider: "piper",
      ttsApiKey: "local-secret",
      kokoroUrl: "https://127.0.0.1:8443/v1/audio/speech",
      kokoroModel: "speaches-ai/piper-en_US-ryan-high",
      kokoroVoice: "ryan",
      ttsSpeed: 1.5,
    });
    rmSync(directory, { recursive: true, force: true });
  });

  it("allows keyless custom Piper endpoints but protects configured credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-converse-config-"));
    const path = join(directory, "config.json");

    writeFileSync(path, JSON.stringify({
      sttProvider: "whisper.cpp",
      ttsProvider: "piper",
      kokoroUrl: "http://speaches.lan:8000/v1/audio/speech",
    }));
    expect(loadConfig(path).kokoroUrl).toBe("http://speaches.lan:8000/v1/audio/speech");

    for (const kokoroUrl of [
      "http://speaches.lan:8000/v1/audio/speech",
      "http://localhost:8000/not-speech",
      "http://user:password@localhost:8000/v1/audio/speech",
    ]) {
      writeFileSync(path, JSON.stringify({
        sttProvider: "whisper.cpp",
        ttsProvider: "piper",
        ttsApiKey: "local-secret",
        kokoroUrl,
      }));
      expect(() => loadConfig(path)).toThrow(/kokoroUrl|loopback/);
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it("selects official Pocket TTS with safe local defaults", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-converse-config-"));
    const path = join(directory, "config.json");

    writeFileSync(path, JSON.stringify({ sttProvider: "whisper.cpp", ttsProvider: "pocket-tts" }));
    expect(loadConfig(path)).toMatchObject({
      sttProvider: "whisper.cpp",
      ttsProvider: "pocket-tts",
      voiceProvider: "local",
      ttsApiKey: undefined,
      kokoroUrl: "http://localhost:8000/tts",
      kokoroModel: "pocket-tts",
      kokoroVoice: "alba",
    });

    writeFileSync(path, JSON.stringify({
      sttProvider: "whisper.cpp",
      ttsProvider: "pocket-tts",
      kokoroUrl: "https://127.0.0.1:8443/tts",
      kokoroVoice: "anna",
    }));
    expect(loadConfig(path)).toMatchObject({
      ttsProvider: "pocket-tts",
      kokoroUrl: "https://127.0.0.1:8443/tts",
      kokoroVoice: "anna",
    });
    rmSync(directory, { recursive: true, force: true });
  });

  it("restricts Pocket TTS to its unauthenticated loopback API", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-converse-config-"));
    const path = join(directory, "config.json");

    for (const kokoroUrl of [
      "http://pocket.lan:8000/tts",
      "http://localhost:8000/not-tts",
      "http://user:password@localhost:8000/tts",
      "http://localhost:8000/tts?voice=alba",
    ]) {
      writeFileSync(path, JSON.stringify({
        sttProvider: "whisper.cpp",
        ttsProvider: "pocket-tts",
        kokoroUrl,
      }));
      expect(() => loadConfig(path)).toThrow(/loopback.*\/tts/);
    }

    writeFileSync(path, JSON.stringify({
      sttProvider: "whisper.cpp",
      ttsProvider: "pocket-tts",
      ttsApiKey: "unsupported-secret",
    }));
    expect(() => loadConfig(path)).toThrow(/ttsApiKey.*unsupported.*official server/i);
    rmSync(directory, { recursive: true, force: true });
  });

  it("selects whisper.cpp explicitly with local defaults and no API key", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-converse-config-"));
    const path = join(directory, "config.json");
    writeFileSync(path, JSON.stringify({
      sttProvider: "whisper.cpp",
      sttApiKey: "must-not-be-used",
      ttsProvider: "local",
      whisperModel: "small.en-q5_0",
      whisperLanguage: "en",
      whisperPrompt: "Software development vocabulary",
    }));

    expect(loadConfig(path)).toMatchObject({
      sttProvider: "whisper.cpp",
      ttsProvider: "local",
      voiceProvider: "local",
      sttApiKey: undefined,
      whisperUrl: "http://localhost:2022/v1/audio/transcriptions",
      whisperModel: "small.en-q5_0",
      whisperLanguage: "en",
      whisperPrompt: "Software development vocabulary",
    });

    writeFileSync(path, JSON.stringify({ sttProvider: "whisper.cpp", ttsProvider: "local" }));
    expect(loadConfig(path).whisperModel).toBe("base.en");
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
