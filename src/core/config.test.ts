import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfigPath, loadConfig } from "./config.js";

const referenceConfig = () => readFileSync(join(process.cwd(), "config.example.conf"), "utf8");

// Each test writes a HOCON file into a throwaway directory and loads it by path.
const dirs: string[] = [];
const writeConf = (contents: string): string => {
  const directory = mkdtempSync(join(tmpdir(), "claude-converse-"));
  dirs.push(directory);
  const path = join(directory, "config.conf");
  writeFileSync(path, contents);
  return path;
};

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("defaults to local whisper.cpp and Kokoro when nothing is configured", () => {
    const path = join(tmpdir(), "claude-converse-absent", "config.conf");
    expect(loadConfig(path)).toMatchObject({
      sttProvider: "whisper.cpp",
      whisperUrl: "http://localhost:2022/v1/audio/transcriptions",
      whisperModel: "base.en",
      sttApiKey: undefined,
      ttsProvider: "kokoro",
      kokoroUrl: "http://localhost:8880/v1/audio/speech",
      kokoroModel: "kokoro",
      kokoroVoice: "af_heart",
      ttsApiKey: undefined,
      port: 45839,
      ttsSpeed: 1.25,
    });
  });

  it("rejects unsupported bytes-per-sample values", () => {
    const path = writeConf(`audio {\n  bytesPerSample = 4\n}`);
    expect(() => loadConfig(path)).toThrow(/unsupported/);
  });

  it("rejects non-positive API timeouts", () => {
    const path = writeConf(`runtime {\n  apiTimeoutMs = 0\n}`);
    expect(() => loadConfig(path)).toThrow(/positive number/);
  });

  it("rejects unsupported speech speeds", () => {
    const path = writeConf(`tts {\n  provider = "kokoro"\n  speed = 4.1\n}`);
    expect(() => loadConfig(path)).toThrow(/between 0.25 and 4/);
  });

  it("accepts a complete OpenAI configuration on both sides", () => {
    const path = writeConf(`
      stt {
        provider = "openai"
        openai {
          apiKey = "stt-key"
        }
      }
      tts {
        provider = "openai"
        openai {
          apiKey = "tts-key"
          speed = 1.5
        }
      }
    `);
    expect(loadConfig(path)).toMatchObject({
      sttProvider: "openai",
      ttsProvider: "openai",
      sttApiKey: "stt-key",
      ttsApiKey: "tts-key",
      whisperUrl: "https://api.openai.com/v1/audio/transcriptions",
      whisperModel: "gpt-4o-transcribe",
      kokoroUrl: "https://api.openai.com/v1/audio/speech",
      kokoroModel: "gpt-4o-mini-tts",
      kokoroVoice: "alloy",
      ttsSpeed: 1.5,
    });
  });

  it("requires a key when OpenAI or Groq is selected", () => {
    const openaiStt = writeConf(`stt {\n  provider = "openai"\n}`);
    expect(() => loadConfig(openaiStt)).toThrow(/sttApiKey.*openai/);
    const openaiTts = writeConf(`tts {\n  provider = "openai"\n}`);
    expect(() => loadConfig(openaiTts)).toThrow(/ttsApiKey.*openai/);
    const groqStt = writeConf(`stt {\n  provider = "groq"\n}`);
    expect(() => loadConfig(groqStt)).toThrow(/sttApiKey.*groq/);
  });

  it("selects OpenAI independently for STT and TTS", () => {
    const sttOnly = writeConf(`
      stt {
        provider = "openai"
        openai {
          apiKey = "stt-key"
        }
      }
      tts {
        provider = "local"
      }
    `);
    expect(loadConfig(sttOnly)).toMatchObject({
      sttProvider: "openai",
      ttsProvider: "local",
      sttApiKey: "stt-key",
      ttsApiKey: undefined,
      whisperUrl: "https://api.openai.com/v1/audio/transcriptions",
      kokoroUrl: "http://localhost:8880/v1/audio/speech",
      kokoroModel: "kokoro",
    });

    const ttsOnly = writeConf(`
      stt {
        provider = "local"
      }
      tts {
        provider = "openai"
        openai {
          apiKey = "tts-key"
        }
      }
    `);
    expect(loadConfig(ttsOnly)).toMatchObject({
      sttProvider: "local",
      ttsProvider: "openai",
      sttApiKey: undefined,
      ttsApiKey: "tts-key",
      whisperUrl: "http://localhost:2022/v1/audio/transcriptions",
      kokoroUrl: "https://api.openai.com/v1/audio/speech",
      kokoroModel: "gpt-4o-mini-tts",
    });
  });

  it("validates only the OpenAI side's endpoint", () => {
    const stt = writeConf(`
      stt {
        provider = "openai"
        openai {
          apiKey = "stt-key"
          url = "https://example.com/v1/audio/transcriptions"
        }
      }
      tts {
        provider = "local"
      }
    `);
    expect(() => loadConfig(stt)).toThrow(/whisperUrl.*api\.openai\.com/);

    const tts = writeConf(`
      stt {
        provider = "local"
      }
      tts {
        provider = "openai"
        openai {
          apiKey = "tts-key"
          url = "http://localhost:8880/v1/audio/speech"
        }
      }
    `);
    expect(() => loadConfig(tts)).toThrow(/kokoroUrl.*api\.openai\.com/);
  });

  it("selects Kokoro with local defaults and never sends a key", () => {
    const custom = writeConf(`
      stt {
        provider = "whisper.cpp"
      }
      tts {
        provider = "kokoro"
        kokoro {
          apiKey = "must-not-be-used"
          url = "http://127.0.0.1:9999/v1/audio/speech"
          model = "kokoro-v1"
          voice = "af_sky"
        }
      }
    `);
    expect(loadConfig(custom)).toMatchObject({
      sttProvider: "whisper.cpp",
      ttsProvider: "kokoro",
      ttsApiKey: undefined,
      kokoroUrl: "http://127.0.0.1:9999/v1/audio/speech",
      kokoroModel: "kokoro-v1",
      kokoroVoice: "af_sky",
    });

    const defaults = writeConf(`tts {\n  provider = "kokoro"\n}`);
    expect(loadConfig(defaults)).toMatchObject({
      kokoroUrl: "http://localhost:8880/v1/audio/speech",
      kokoroModel: "kokoro",
      kokoroVoice: "af_heart",
    });
  });

  it("selects Groq with hosted defaults and rejects every non-official URL", () => {
    const ok = writeConf(`
      stt {
        provider = "groq"
        groq {
          apiKey = "groq-key"
        }
      }
      tts {
        provider = "kokoro"
      }
    `);
    expect(loadConfig(ok)).toMatchObject({
      sttProvider: "groq",
      sttApiKey: "groq-key",
      whisperUrl: "https://api.groq.com/openai/v1/audio/transcriptions",
      whisperModel: "whisper-large-v3-turbo",
    });

    for (const url of [
      "http://api.groq.com/openai/v1/audio/transcriptions",
      "https://api.groq.com.evil.example/openai/v1/audio/transcriptions",
      "https://api.groq.com/openai/v1/chat/completions",
    ]) {
      const bad = writeConf(`
        stt {
          provider = "groq"
          groq {
            apiKey = "groq-key"
            url = "${url}"
          }
        }
      `);
      expect(() => loadConfig(bad)).toThrow(/whisperUrl.*api\.groq\.com/);
    }
  });

  it("selects Speaches with documented defaults and loopback-only authentication", () => {
    const defaults = writeConf(`stt {\n  provider = "speaches"\n}`);
    expect(loadConfig(defaults)).toMatchObject({
      sttProvider: "speaches",
      sttApiKey: undefined,
      whisperUrl: "http://localhost:8000/v1/audio/transcriptions",
      whisperModel: "Systran/faster-distil-whisper-small.en",
    });

    const authed = writeConf(`
      stt {
        provider = "speaches"
        speaches {
          apiKey = "local-secret"
          url = "https://127.0.0.1:8443/v1/audio/transcriptions"
          prompt = "Programming terms"
        }
      }
    `);
    expect(loadConfig(authed)).toMatchObject({
      sttApiKey: "local-secret",
      whisperUrl: "https://127.0.0.1:8443/v1/audio/transcriptions",
      whisperPrompt: "Programming terms",
    });

    const keyedRemote = writeConf(`
      stt {
        provider = "speaches"
        speaches {
          apiKey = "local-secret"
          url = "http://speaches.lan:8000/v1/audio/transcriptions"
        }
      }
    `);
    expect(() => loadConfig(keyedRemote)).toThrow(/whisperUrl|loopback/);

    const keylessRemote = writeConf(`
      stt {
        provider = "speaches"
        speaches {
          url = "http://speaches.lan:8000/v1/audio/transcriptions"
        }
      }
    `);
    expect(loadConfig(keylessRemote).whisperUrl).toBe("http://speaches.lan:8000/v1/audio/transcriptions");
  });

  it("selects Speaches Kokoro ONNX with defaults, loopback auth, and a tighter speed range", () => {
    const defaults = writeConf(`tts {\n  provider = "speaches-kokoro"\n}`);
    expect(loadConfig(defaults)).toMatchObject({
      ttsProvider: "speaches-kokoro",
      ttsApiKey: undefined,
      kokoroUrl: "http://localhost:8000/v1/audio/speech",
      kokoroModel: "speaches-ai/Kokoro-82M-v1.0-ONNX",
      kokoroVoice: "af_heart",
    });

    const tooFast = writeConf(`tts {\n  provider = "speaches-kokoro"\n  speed = 2.1\n}`);
    expect(() => loadConfig(tooFast)).toThrow(/ttsSpeed.*0\.5.*2/);

    const keyedRemote = writeConf(`
      tts {
        provider = "speaches-kokoro"
        speaches-kokoro {
          apiKey = "local-secret"
          url = "http://speaches.lan:8000/v1/audio/speech"
        }
      }
    `);
    expect(() => loadConfig(keyedRemote)).toThrow(/kokoroUrl|loopback/);
  });

  it("selects Speaches Piper with verified US English defaults", () => {
    const defaults = writeConf(`
      stt {
        provider = "whisper.cpp"
      }
      tts {
        provider = "piper"
      }
    `);
    expect(loadConfig(defaults)).toMatchObject({
      ttsProvider: "piper",
      ttsApiKey: undefined,
      kokoroUrl: "http://localhost:8000/v1/audio/speech",
      kokoroModel: "speaches-ai/piper-en_US-lessac-medium",
      kokoroVoice: "lessac",
    });

    const custom = writeConf(`
      tts {
        provider = "piper"
        piper {
          model = "speaches-ai/piper-en_US-ryan-high"
          voice = "ryan"
        }
      }
    `);
    expect(loadConfig(custom)).toMatchObject({
      kokoroModel: "speaches-ai/piper-en_US-ryan-high",
      kokoroVoice: "ryan",
    });
  });

  it("selects official Pocket TTS and restricts it to its unauthenticated loopback API", () => {
    const defaults = writeConf(`tts {\n  provider = "pocket-tts"\n}`);
    expect(loadConfig(defaults)).toMatchObject({
      ttsProvider: "pocket-tts",
      ttsApiKey: undefined,
      kokoroUrl: "http://localhost:8000/tts",
      kokoroModel: "pocket-tts",
      kokoroVoice: "alba",
    });

    for (const url of [
      "http://pocket.lan:8000/tts",
      "http://localhost:8000/not-tts",
      "http://localhost:8000/tts?voice=alba",
    ]) {
      const bad = writeConf(`
        tts {
          provider = "pocket-tts"
          pocket-tts {
            url = "${url}"
          }
        }
      `);
      expect(() => loadConfig(bad)).toThrow(/loopback.*\/tts/);
    }

    const keyed = writeConf(`
      tts {
        provider = "pocket-tts"
        pocket-tts {
          apiKey = "unsupported"
        }
      }
    `);
    expect(() => loadConfig(keyed)).toThrow(/ttsApiKey.*unsupported.*official server/i);

    const modeled = writeConf(`
      tts {
        provider = "pocket-tts"
        pocket-tts {
          model = "pocket-tts-large"
        }
      }
    `);
    expect(() => loadConfig(modeled)).toThrow(/kokoroModel.*unsupported.*no model field/i);

    const sped = writeConf(`
      tts {
        provider = "pocket-tts"
        pocket-tts {
          speed = 1.5
        }
      }
    `);
    expect(() => loadConfig(sped)).toThrow(/ttsSpeed.*unsupported.*no speed field/i);

    const sectionLevel = writeConf(`
      tts {
        provider = "pocket-tts"
        speed = 1.5
      }
    `);
    expect(() => loadConfig(sectionLevel)).toThrow(/ttsSpeed.*unsupported.*no speed field/i);
    expect(loadConfig(defaults).ttsSpeed).toBe(1.25);
  });

  it("selects whisper.cpp with local defaults and never sends a key", () => {
    const custom = writeConf(`
      stt {
        provider = "whisper.cpp"
        whisper.cpp {
          model = "small.en-q5_0"
          prompt = "Software development vocabulary"
        }
      }
      tts {
        provider = "local"
      }
    `);
    expect(loadConfig(custom)).toMatchObject({
      sttProvider: "whisper.cpp",
      sttApiKey: undefined,
      whisperUrl: "http://localhost:2022/v1/audio/transcriptions",
      whisperModel: "small.en-q5_0",
      whisperPrompt: "Software development vocabulary",
    });

    const defaults = writeConf(`stt {\n  provider = "whisper.cpp"\n}`);
    expect(loadConfig(defaults).whisperModel).toBe("base.en");
  });

  it("selects Moonshine with a persistent local sidecar and documented defaults", () => {
    const custom = writeConf(`
      stt {
        provider = "moonshine"
      }
      tts {
        provider = "pocket-tts"
      }
      moonshine {
        pythonCommand = "/opt/moonshine/bin/python"
        sidecarPath = "/opt/converse/moonshine-sidecar.py"
        language = "es"
        model = "medium-streaming"
      }
    `);
    expect(loadConfig(custom)).toMatchObject({
      sttProvider: "moonshine",
      ttsProvider: "pocket-tts",
      sttApiKey: undefined,
      moonshinePythonCommand: "/opt/moonshine/bin/python",
      moonshineSidecarPath: "/opt/converse/moonshine-sidecar.py",
      moonshineLanguage: "es",
      moonshineModel: "medium-streaming",
    });

    const defaults = writeConf(`stt {\n  provider = "moonshine"\n}`);
    const config = loadConfig(defaults);
    expect(config).toMatchObject({
      moonshinePythonCommand: "python3",
      moonshineLanguage: "en",
      moonshineModel: "small-streaming",
    });
    expect(config.moonshineSidecarPath).toMatch(/services\/moonshine-sidecar\.py$/);
  });

  it("rejects Moonshine credentials, primed prompts, and invalid languages or models", () => {
    const withKey = writeConf(`
      stt {
        provider = "moonshine"
        apiKey = "not-used"
      }
    `);
    expect(() => loadConfig(withKey)).toThrow(/sttApiKey.*moonshine/);

    const withPrompt = writeConf(`
      stt {
        provider = "moonshine"
        prompt = "unsupported priming"
      }
    `);
    expect(() => loadConfig(withPrompt)).toThrow(/whisperPrompt.*moonshine/);

    const badLanguage = writeConf(`
      stt {
        provider = "moonshine"
      }
      moonshine {
        language = "fr"
      }
    `);
    expect(() => loadConfig(badLanguage)).toThrow(/moonshine.*language|moonshineLanguage/i);

    const badModel = writeConf(`
      stt {
        provider = "moonshine"
      }
      moonshine {
        model = "large"
      }
    `);
    expect(() => loadConfig(badModel)).toThrow(/moonshine.*model|moonshineModel/i);
  });

  it("applies the selected provider's sub-block and ignores the others", () => {
    const path = writeConf(`
      stt {
        provider = "groq"
        groq {
          apiKey = "gsk-block-key"
          prompt = "code terms"
        }
        openai {
          apiKey = "sk-should-be-ignored"
        }
      }
      tts {
        provider = "kokoro"
        kokoro {
          voice = "af_sky"
        }
        openai {
          apiKey = "sk-should-be-ignored"
          voice = "alloy"
        }
      }
    `);
    expect(loadConfig(path)).toMatchObject({
      sttProvider: "groq",
      sttApiKey: "gsk-block-key",
      whisperPrompt: "code terms",
      whisperUrl: "https://api.groq.com/openai/v1/audio/transcriptions",
      ttsProvider: "kokoro",
      ttsApiKey: undefined,
      kokoroVoice: "af_sky",
    });
  });

  it("recombines the dotted whisper.cpp sub-block key the HOCON parser splits", () => {
    const path = writeConf(`
      stt {
        provider = "whisper.cpp"
        whisper.cpp {
          model = "small.en-q5_0"
        }
        groq {
          apiKey = "gsk-inert"
        }
      }
      tts {
        provider = "kokoro"
      }
    `);
    expect(loadConfig(path)).toMatchObject({
      sttProvider: "whisper.cpp",
      whisperModel: "small.en-q5_0",
      sttApiKey: undefined,
    });
  });

  it("lets a provider sub-block override a section-level setting for that provider", () => {
    const path = writeConf(`
      stt {
        provider = "speaches"
        model = "section-level-model"
        speaches {
          model = "block-level-model"
        }
      }
      tts {
        provider = "kokoro"
      }
    `);
    expect(loadConfig(path).whisperModel).toBe("block-level-model");
  });

  it("reports unknown and mistyped fields inside a provider sub-block", () => {
    const unknown = writeConf(`
      stt {
        provider = "groq"
        groq {
          mystery = true
        }
      }
    `);
    expect(() => loadConfig(unknown)).toThrow(/Unknown.*stt\.groq\.mystery/);

    const mistyped = writeConf(`
      tts {
        provider = "openai"
        openai {
          speed = "fast"
        }
      }
    `);
    expect(() => loadConfig(mistyped)).toThrow(/tts\.openai\.speed.*number/);
  });

  it("loads grouped HOCON settings and maps every section", () => {
    const path = writeConf(`
      stt {
        provider = "speaches"
        apiKey = "stt-key"
        url = "http://localhost:8000/v1/audio/transcriptions"
        model = "custom-stt"
        language = "en"
        prompt = "code"
      }
      tts {
        provider = "piper"
        apiKey = "tts-key"
        url = "http://localhost:8000/v1/audio/speech"
        model = "custom-piper"
        voice = "lessac"
        speed = 1.4
      }
      moonshine {
        pythonCommand = "python3.12"
        sidecarPath = "/tmp/sidecar.py"
        language = "es"
        model = "base-streaming"
      }
      audio {
        sampleRate = 48000
        channels = 1
        bytesPerSample = 2
        frameDurationMs = 20
        recorder {
          command = "arecord"
          device = "hw:1"
          additionalArgs = ["--quiet"]
        }
        player {
          command = "aplay"
          additionalArgs = ["--quiet"]
        }
      }
      vad {
        threshold = 400
        speechStartFrames = 4
        chunkSilenceFrames = 21
        utteranceEndFrames = 61
        minUtteranceFrames = 11
        bargeInEnergyMultiplier = 2.5
        bargeInFrames = 7
        preBufferFrames = 12
      }
      status {
        recentMaxEntries = 60
        windowSeconds = 45
        prefix = "mic "
        separator = " / "
      }
      server {
        host = "127.0.0.2"
        port = 45840
      }
      runtime {
        apiTimeoutMs = 70000
        voiceWaitMs = 6000
      }
    `);

    expect(loadConfig(path)).toMatchObject({
      sttProvider: "speaches",
      sttApiKey: "stt-key",
      whisperUrl: "http://localhost:8000/v1/audio/transcriptions",
      whisperModel: "custom-stt",
      whisperLanguage: "en",
      whisperPrompt: "code",
      ttsProvider: "piper",
      ttsApiKey: "tts-key",
      kokoroUrl: "http://localhost:8000/v1/audio/speech",
      kokoroModel: "custom-piper",
      kokoroVoice: "lessac",
      ttsSpeed: 1.4,
      moonshinePythonCommand: "python3.12",
      moonshineSidecarPath: "/tmp/sidecar.py",
      moonshineLanguage: "es",
      moonshineModel: "base-streaming",
      sampleRate: 48000,
      channels: 1,
      bytesPerSample: 2,
      frameDurationMs: 20,
      recorderCommand: "arecord",
      recorderDevice: "hw:1",
      recorderAdditionalArgs: ["--quiet"],
      playerCommand: "aplay",
      playerAdditionalArgs: ["--quiet"],
      vadThreshold: 400,
      vadSpeechStartFrames: 4,
      vadChunkSilenceFrames: 21,
      vadUtteranceEndFrames: 61,
      vadMinUtteranceFrames: 11,
      vadBargeInEnergyMultiplier: 2.5,
      vadBargeInFrames: 7,
      vadPreBufferFrames: 12,
      recentMaxEntries: 60,
      statusWindowSeconds: 45,
      statusPrefix: "mic ",
      statusSeparator: " / ",
      host: "127.0.0.2",
      port: 45840,
      apiTimeoutMs: 70000,
      voiceWaitMs: 6000,
    });
  });

  it("reports malformed, unknown, and incorrectly typed HOCON settings", () => {
    const providerType = writeConf(`stt {\n  provider = 42\n}`);
    expect(() => loadConfig(providerType)).toThrow(/stt\.provider.*stt-provider/);

    const unknownNested = writeConf(`tts {\n  mystery = true\n}`);
    expect(() => loadConfig(unknownNested)).toThrow(/Unknown.*tts\.mystery/);

    const unknownTop = writeConf(`typoSetting = true`);
    expect(() => loadConfig(unknownTop)).toThrow(/Unknown.*typoSetting/);

    const scalarSection = writeConf(`stt = openai`);
    expect(() => loadConfig(scalarSection)).toThrow(/stt.*must be an object/);

    const wrongType = writeConf(`server {\n  port = "45839"\n}`);
    expect(() => loadConfig(wrongType)).toThrow(/port.*must be number/);

    const unbalanced = writeConf(`stt {`);
    expect(() => loadConfig(unbalanced)).toThrow(/Invalid HOCON/);
  });

  it("parses the shipped reference config with its default providers", () => {
    const config = loadConfig(join(process.cwd(), "config.example.conf"));
    expect(config).toMatchObject({
      sttProvider: "whisper.cpp",
      whisperModel: "base.en",
      ttsProvider: "kokoro",
      kokoroVoice: "af_heart",
    });
  });

  it("copies the reference config to a missing default path, privately", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-converse-xdg-"));
    dirs.push(directory);
    const original = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = directory;
    try {
      const path = defaultConfigPath();
      expect(path).toBe(join(directory, "claude-converse", "config.conf"));
      expect(existsSync(path)).toBe(false);
      expect(loadConfig()).toMatchObject({ sttProvider: "whisper.cpp", ttsProvider: "kokoro" });
      expect(readFileSync(path, "utf8")).toBe(referenceConfig());
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(() => loadConfig()).not.toThrow();
    } finally {
      if (original === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = original;
    }
  });

  it("does not create an explicitly requested missing config", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-converse-explicit-"));
    dirs.push(directory);
    const path = join(directory, "nested", "config.conf");
    expect(loadConfig(path).port).toBe(45839);
    expect(existsSync(join(directory, "nested"))).toBe(false);
  });
});
