import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseString } from "hocon-config";

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
  apiTimeoutMs: number;
  whisperUrl: string;
  whisperModel: string;
  whisperLanguage: string;
  whisperPrompt: string;
  moonshinePythonCommand: string;
  moonshineSidecarPath: string;
  moonshineLanguage: MoonshineLanguage;
  moonshineModel: MoonshineModel;
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

export type SttProvider = "local" | "moonshine" | "openai" | "groq" | "speaches" | "whisper.cpp";
export type TtsProvider = "local" | "openai" | "kokoro" | "piper" | "pocket-tts" | "speaches-kokoro";
export type MoonshineLanguage = "ar" | "en" | "es" | "ja" | "ko" | "uk" | "vi" | "zh";
export type MoonshineModel = "tiny" | "base" | "tiny-streaming" | "base-streaming" | "small-streaming" | "medium-streaming";
type FileConfig = Partial<ConverseConfig>;
type ValueKind = "number" | "string" | "string[]" | "stt-provider" | "tts-provider" | "moonshine-language" | "moonshine-model";
type FileConfigKey = keyof FileConfig;
type HoconSchema = { [key: string]: FileConfigKey | HoconSchema };
type ProviderFieldSchema = Record<string, FileConfigKey>;
/** Per-provider sub-block overrides keyed by provider id, merged only for the selected provider. */
type ProviderBlocks = Partial<Record<string, Partial<FileConfig>>>;
interface ParsedFile {
  values: FileConfig;
  sttBlocks: ProviderBlocks;
  ttsBlocks: ProviderBlocks;
}

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
  apiTimeoutMs: "number",
  whisperUrl: "string",
  whisperModel: "string",
  whisperLanguage: "string",
  whisperPrompt: "string",
  moonshinePythonCommand: "string",
  moonshineSidecarPath: "string",
  moonshineLanguage: "moonshine-language",
  moonshineModel: "moonshine-model",
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

// Fields valid inside `stt { ... }` and each `stt.<provider> { ... }` sub-block.
const sttFieldSchema: ProviderFieldSchema = {
  apiKey: "sttApiKey",
  url: "whisperUrl",
  model: "whisperModel",
  language: "whisperLanguage",
  prompt: "whisperPrompt",
};
// Fields valid inside `tts { ... }` and each `tts.<provider> { ... }` sub-block.
const ttsFieldSchema: ProviderFieldSchema = {
  apiKey: "ttsApiKey",
  url: "kokoroUrl",
  model: "kokoroModel",
  voice: "kokoroVoice",
  speed: "ttsSpeed",
};
// Providers that accept an `stt.<provider>` / `tts.<provider>` override block.
// Moonshine is excluded: its settings live in the dedicated top-level `moonshine { }` section.
const sttBlockProviders: readonly SttProvider[] = ["local", "openai", "groq", "speaches", "whisper.cpp"];
const ttsBlockProviders: readonly TtsProvider[] = ["local", "openai", "kokoro", "piper", "pocket-tts", "speaches-kokoro"];

// Sections other than stt/tts, which are handled by resolveProviderSection.
const topSchema: HoconSchema = {
  moonshine: {
    pythonCommand: "moonshinePythonCommand",
    sidecarPath: "moonshineSidecarPath",
    language: "moonshineLanguage",
    model: "moonshineModel",
  },
  audio: {
    sampleRate: "sampleRate",
    channels: "channels",
    bytesPerSample: "bytesPerSample",
    frameDurationMs: "frameDurationMs",
    recorder: {
      command: "recorderCommand",
      device: "recorderDevice",
      additionalArgs: "recorderAdditionalArgs",
    },
    player: {
      command: "playerCommand",
      additionalArgs: "playerAdditionalArgs",
    },
  },
  vad: {
    threshold: "vadThreshold",
    speechStartFrames: "vadSpeechStartFrames",
    chunkSilenceFrames: "vadChunkSilenceFrames",
    utteranceEndFrames: "vadUtteranceEndFrames",
    minUtteranceFrames: "vadMinUtteranceFrames",
    bargeInEnergyMultiplier: "vadBargeInEnergyMultiplier",
    bargeInFrames: "vadBargeInFrames",
    preBufferFrames: "vadPreBufferFrames",
  },
  status: {
    recentMaxEntries: "recentMaxEntries",
    windowSeconds: "statusWindowSeconds",
    prefix: "statusPrefix",
    separator: "statusSeparator",
  },
  server: {
    host: "host",
    port: "port",
  },
  runtime: {
    apiTimeoutMs: "apiTimeoutMs",
    voiceWaitMs: "voiceWaitMs",
  },
};

// The committed, shipped reference config that first-run copies to the user's
// config directory. Resolves next to this module in dist/ and from source.
export const resolveReferenceConfigPath = (moduleUrl = import.meta.url): string => {
  const candidates = [
    new URL("../../config.example.conf", moduleUrl),
    new URL("../config.example.conf", moduleUrl),
  ];
  const match = candidates.find((candidate) => existsSync(candidate));
  return fileURLToPath(match ?? candidates[0]!);
};

const configDirectory = (): string =>
  join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "claude-converse");

export const defaultConfigPath = (): string => join(configDirectory(), "config.conf");

const ensureDefaultConfig = (): string => {
  const hoconPath = defaultConfigPath();
  if (existsSync(hoconPath)) return hoconPath;

  try {
    mkdirSync(dirname(hoconPath), { recursive: true, mode: 0o700 });
    const reference = readFileSync(resolveReferenceConfigPath(), "utf8");
    writeFileSync(hoconPath, reference, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new Error(`Cannot create Converse config ${hoconPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return hoconPath;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const valueMatchesKind = (item: unknown, kind: ValueKind): boolean => kind === "string[]"
  ? Array.isArray(item) && item.every((entry) => typeof entry === "string")
  : kind === "stt-provider"
    ? item === "local" || item === "moonshine" || item === "openai" || item === "groq" || item === "speaches" || item === "whisper.cpp"
    : kind === "moonshine-language"
      ? item === "ar" || item === "en" || item === "es" || item === "ja" || item === "ko" || item === "uk" || item === "vi" || item === "zh"
      : kind === "moonshine-model"
        ? item === "tiny" || item === "base" || item === "tiny-streaming" || item === "base-streaming" || item === "small-streaming" || item === "medium-streaming"
        : kind === "tts-provider"
          ? item === "local" || item === "openai" || item === "kokoro" || item === "piper" || item === "pocket-tts" || item === "speaches-kokoro"
          : typeof item === kind && (kind !== "number" || Number.isFinite(item));

const validateSetting = (key: FileConfigKey, item: unknown, displayPath: string, path: string): void => {
  const kind = fileConfigKinds[key as keyof ConverseConfig];
  if (!kind || !valueMatchesKind(item, kind)) {
    throw new Error(`Converse config setting ${displayPath} in ${path} must be ${kind ?? "supported"}`);
  }
};

// The HOCON parser splits unquoted-and-quoted keys on periods, so `whisper.cpp` arrives
// nested as { whisper: { cpp: {...} } }. Recombine it back into the "whisper.cpp" provider id.
const recombineWhisperCpp = (input: Record<string, unknown>): Record<string, unknown> => {
  const nested = input.whisper;
  if (isObject(nested) && isObject(nested.cpp)) {
    const { whisper: _removed, ...rest } = input;
    return { ...rest, "whisper.cpp": nested.cpp };
  }
  return input;
};

const resolveProviderBlock = (item: unknown, fields: ProviderFieldSchema, displayPath: string, path: string): Partial<FileConfig> => {
  if (!isObject(item)) throw new Error(`Converse config setting ${displayPath} in ${path} must be an object`);
  const block: Partial<Record<FileConfigKey, unknown>> = {};
  for (const [name, value] of Object.entries(item)) {
    const target = fields[name];
    if (!target) throw new Error(`Unknown Converse config setting ${displayPath}.${name} in ${path}`);
    validateSetting(target, value, `${displayPath}.${name}`, path);
    block[target] = value;
  }
  return block as Partial<FileConfig>;
};

const resolveProviderSection = (
  raw: unknown,
  section: "stt" | "tts",
  fields: ProviderFieldSchema,
  providerKey: FileConfigKey,
  blockProviders: readonly string[],
  values: Partial<Record<FileConfigKey, unknown>>,
  path: string,
): ProviderBlocks => {
  if (!isObject(raw)) throw new Error(`Converse config setting ${section} in ${path} must be an object`);
  const input = section === "stt" ? recombineWhisperCpp(raw) : raw;
  const blocks: ProviderBlocks = {};
  for (const [name, item] of Object.entries(input)) {
    const displayPath = `${section}.${name}`;
    if (name === "provider") {
      validateSetting(providerKey, item, displayPath, path);
      values[providerKey] = item;
    } else if (name in fields) {
      const target = fields[name]!;
      validateSetting(target, item, displayPath, path);
      values[target] = item;
    } else if (blockProviders.includes(name)) {
      blocks[name] = resolveProviderBlock(item, fields, displayPath, path);
    } else {
      throw new Error(`Unknown Converse config setting ${displayPath} in ${path}`);
    }
  }
  return blocks;
};

const normalizeHocon = (value: unknown, path: string): ParsedFile => {
  if (!isObject(value)) throw new Error(`Converse config ${path} must contain a HOCON object`);
  const values: Partial<Record<FileConfigKey, unknown>> = {};
  let sttBlocks: ProviderBlocks = {};
  let ttsBlocks: ProviderBlocks = {};

  const visit = (input: Record<string, unknown>, schema: HoconSchema, prefix: string): void => {
    for (const [name, item] of Object.entries(input)) {
      const displayPath = prefix ? `${prefix}.${name}` : name;
      const target = schema[name];
      if (!target) throw new Error(`Unknown Converse config setting ${displayPath} in ${path}`);
      if (typeof target === "string") {
        validateSetting(target, item, displayPath, path);
        values[target] = item;
      } else {
        if (!isObject(item)) throw new Error(`Converse config setting ${displayPath} in ${path} must be an object`);
        visit(item, target, displayPath);
      }
    }
  };

  for (const [name, item] of Object.entries(value)) {
    if (name === "stt") {
      sttBlocks = resolveProviderSection(item, "stt", sttFieldSchema, "sttProvider", sttBlockProviders, values, path);
    } else if (name === "tts") {
      ttsBlocks = resolveProviderSection(item, "tts", ttsFieldSchema, "ttsProvider", ttsBlockProviders, values, path);
    } else {
      const target = topSchema[name];
      if (!target) throw new Error(`Unknown Converse config setting ${name} in ${path}`);
      if (typeof target === "string") {
        validateSetting(target, item, name, path);
        values[target] = item;
      } else {
        if (!isObject(item)) throw new Error(`Converse config setting ${name} in ${path} must be an object`);
        visit(item, target, name);
      }
    }
  }

  return { values: values as FileConfig, sttBlocks, ttsBlocks };
};

const assertBalancedHocon = (source: string, path: string): void => {
  const stack: string[] = [];
  let quoted = false;
  let escaped = false;
  let lineComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "#" || (character === "/" && next === "/")) lineComment = true;
    else if (character === "{" || character === "[") stack.push(character);
    else if (character === "}" || character === "]") {
      const opening = stack.pop();
      if ((character === "}" && opening !== "{") || (character === "]" && opening !== "[")) {
        throw new Error(`Invalid HOCON in Converse config ${path}: mismatched ${character}`);
      }
    }
  }
  if (quoted || stack.length > 0) throw new Error(`Invalid HOCON in Converse config ${path}: unclosed string or collection`);
};

const readFileConfig = (path: string): ParsedFile => {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { values: {}, sttBlocks: {}, ttsBlocks: {} };
    throw new Error(`Cannot read Converse config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    assertBalancedHocon(source, path);
    return normalizeHocon(parseString(source, dirname(path), { overrides: {} }), path);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Converse config")) throw error;
    throw new Error(`Invalid HOCON in Converse config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

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

const speachesAudioUrl = (value: string, pathname: "/v1/audio/transcriptions" | "/v1/audio/speech"): URL | undefined => {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:")
      || url.pathname !== pathname
      || url.username
      || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
};

const isLoopbackHost = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);

const isPocketTtsUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && isLoopbackHost(url.hostname)
      && url.pathname === "/tts"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
};

export const resolveMoonshineSidecarPath = (moduleUrl = import.meta.url): string => {
  const candidates = [
    new URL("../services/moonshine-sidecar.py", moduleUrl),
    new URL("../../services/moonshine-sidecar.py", moduleUrl),
  ];
  const match = candidates.find((candidate) => existsSync(candidate));
  return fileURLToPath(match ?? candidates[0]!);
};

export const loadConfig = (path?: string): ConverseConfig => {
  const resolvedPath = path ?? ensureDefaultConfig();
  const { values: file, sttBlocks, ttsBlocks } = readFileConfig(resolvedPath);
  const sttProvider = file.sttProvider ?? "whisper.cpp";
  const ttsProvider = file.ttsProvider ?? "kokoro";
  // Overlay the selected provider's sub-block over the section-level file settings.
  const stt = { ...file, ...sttBlocks[sttProvider] };
  const tts = { ...file, ...ttsBlocks[ttsProvider] };

  const sttApiKey = sttProvider === "openai" || sttProvider === "groq" || sttProvider === "speaches"
    ? stt.sttApiKey
    : undefined;
  const ttsApiKey = ttsProvider === "openai" || ttsProvider === "speaches-kokoro" || ttsProvider === "piper"
    ? tts.ttsApiKey
    : undefined;
  const bytesPerSample = file.bytesPerSample ?? 2;
  const apiTimeoutMs = file.apiTimeoutMs ?? 60_000;
  const ttsSpeed = tts.ttsSpeed ?? 1.25;
  const voiceWaitMs = file.voiceWaitMs ?? 5_000;
  const whisperPrompt = stt.whisperPrompt ?? "";
  const whisperUrl = stt.whisperUrl ?? (sttProvider === "openai"
    ? "https://api.openai.com/v1/audio/transcriptions"
    : sttProvider === "groq"
      ? "https://api.groq.com/openai/v1/audio/transcriptions"
      : sttProvider === "speaches"
        ? "http://localhost:8000/v1/audio/transcriptions"
        : "http://localhost:2022/v1/audio/transcriptions");
  const kokoroUrl = tts.kokoroUrl ?? (ttsProvider === "openai"
    ? "https://api.openai.com/v1/audio/speech"
    : ttsProvider === "speaches-kokoro" || ttsProvider === "piper"
      ? "http://localhost:8000/v1/audio/speech"
      : ttsProvider === "pocket-tts"
        ? "http://localhost:8000/tts"
        : "http://localhost:8880/v1/audio/speech");

  if (bytesPerSample !== 2) throw new Error(`bytesPerSample=${bytesPerSample} is unsupported; only 2-byte S16_LE audio is supported`);
  if (sttProvider === "moonshine" && stt.sttApiKey !== undefined) {
    throw new Error("sttApiKey is unsupported when sttProvider is moonshine; Moonshine runs as a local child process");
  }
  if (sttProvider === "moonshine" && whisperPrompt.trim()) {
    throw new Error("whisperPrompt is unsupported when sttProvider is moonshine");
  }
  if (file.moonshinePythonCommand !== undefined && !file.moonshinePythonCommand.trim()) {
    throw new Error("moonshinePythonCommand must not be empty");
  }
  if (file.moonshineSidecarPath !== undefined && !file.moonshineSidecarPath.trim()) {
    throw new Error("moonshineSidecarPath must not be empty");
  }
  if ((sttProvider === "openai" || sttProvider === "groq") && !sttApiKey) {
    throw new Error(`sttApiKey must be set in ${resolvedPath} when sttProvider is ${sttProvider}`);
  }
  if (ttsProvider === "openai" && !ttsApiKey) throw new Error(`ttsApiKey must be set in ${resolvedPath} when ttsProvider is openai`);
  if (ttsProvider === "pocket-tts" && tts.ttsApiKey !== undefined) {
    throw new Error("ttsApiKey is unsupported when ttsProvider is pocket-tts; the official server has no authentication");
  }
  if (ttsProvider === "pocket-tts" && tts.kokoroModel !== undefined) {
    throw new Error("kokoroModel is unsupported when ttsProvider is pocket-tts; the official /tts API has no model field");
  }
  if (ttsProvider === "pocket-tts" && tts.ttsSpeed !== undefined) {
    throw new Error("ttsSpeed is unsupported when ttsProvider is pocket-tts; the official /tts API has no speed field");
  }
  if (apiTimeoutMs <= 0) throw new Error("apiTimeoutMs must be a positive number");
  if (ttsSpeed < 0.25 || ttsSpeed > 4) throw new Error("ttsSpeed must be between 0.25 and 4");
  if (ttsProvider === "speaches-kokoro" && (ttsSpeed < 0.5 || ttsSpeed > 2)) {
    throw new Error("ttsSpeed must be between 0.5 and 2 when ttsProvider is speaches-kokoro");
  }
  if (voiceWaitMs <= 0) throw new Error("voiceWaitMs must be a positive number");
  if (sttProvider === "openai" && !isOpenAiUrl(whisperUrl)) {
    throw new Error("whisperUrl must use https://api.openai.com when sttProvider is openai");
  }
  if (sttProvider === "groq" && !isGroqTranscriptionUrl(whisperUrl)) {
    throw new Error("whisperUrl must use https://api.groq.com/openai/v1/audio/transcriptions when sttProvider is groq");
  }
  if (sttProvider === "speaches") {
    const url = speachesAudioUrl(whisperUrl, "/v1/audio/transcriptions");
    if (!url) throw new Error("whisperUrl must be an HTTP(S) /v1/audio/transcriptions URL without embedded credentials when sttProvider is speaches");
    if (sttApiKey && !isLoopbackHost(url.hostname)) {
      throw new Error("sttApiKey may be used with Speaches only on a loopback whisperUrl");
    }
  }
  if (ttsProvider === "openai" && !isOpenAiUrl(kokoroUrl)) {
    throw new Error("kokoroUrl must use https://api.openai.com when ttsProvider is openai");
  }
  if (ttsProvider === "speaches-kokoro" || ttsProvider === "piper") {
    const url = speachesAudioUrl(kokoroUrl, "/v1/audio/speech");
    if (!url) throw new Error(`kokoroUrl must be an HTTP(S) /v1/audio/speech URL without embedded credentials when ttsProvider is ${ttsProvider}`);
    if (ttsApiKey && !isLoopbackHost(url.hostname)) {
      const backend = ttsProvider === "piper" ? "Speaches Piper" : "Speaches Kokoro";
      throw new Error(`ttsApiKey may be used with ${backend} only on a loopback kokoroUrl`);
    }
  }
  if (ttsProvider === "pocket-tts" && !isPocketTtsUrl(kokoroUrl)) {
    throw new Error("kokoroUrl must be a loopback HTTP(S) /tts URL without credentials, query, or fragment when ttsProvider is pocket-tts");
  }

  return {
    sampleRate: file.sampleRate ?? 16_000,
    channels: file.channels ?? 1,
    bytesPerSample,
    frameDurationMs: file.frameDurationMs ?? 30,
    vadThreshold: file.vadThreshold ?? 300,
    vadSpeechStartFrames: file.vadSpeechStartFrames ?? 3,
    vadChunkSilenceFrames: file.vadChunkSilenceFrames ?? 20,
    vadUtteranceEndFrames: file.vadUtteranceEndFrames ?? 60,
    vadMinUtteranceFrames: file.vadMinUtteranceFrames ?? 10,
    vadBargeInEnergyMultiplier: file.vadBargeInEnergyMultiplier ?? 2.0,
    vadBargeInFrames: file.vadBargeInFrames ?? 6,
    vadPreBufferFrames: file.vadPreBufferFrames ?? 10,
    recentMaxEntries: file.recentMaxEntries ?? 50,
    statusWindowSeconds: file.statusWindowSeconds ?? 30,
    statusPrefix: file.statusPrefix ?? "🎤 ",
    statusSeparator: file.statusSeparator ?? " | ",
    sttProvider,
    ttsProvider,
    sttApiKey,
    ttsApiKey,
    apiTimeoutMs,
    whisperUrl,
    whisperModel: stt.whisperModel ?? (sttProvider === "openai"
      ? "gpt-4o-transcribe"
      : sttProvider === "groq"
        ? "whisper-large-v3-turbo"
        : sttProvider === "speaches"
          ? "Systran/faster-distil-whisper-small.en"
          : sttProvider === "whisper.cpp"
            ? "base.en"
            : "base"),
    whisperLanguage: stt.whisperLanguage ?? "en",
    whisperPrompt,
    moonshinePythonCommand: file.moonshinePythonCommand ?? "python3",
    moonshineSidecarPath: file.moonshineSidecarPath ?? resolveMoonshineSidecarPath(),
    moonshineLanguage: file.moonshineLanguage ?? "en",
    moonshineModel: file.moonshineModel ?? "small-streaming",
    kokoroUrl,
    kokoroVoice: tts.kokoroVoice ?? (ttsProvider === "openai"
      ? "alloy"
      : ttsProvider === "piper"
        ? "lessac"
        : ttsProvider === "pocket-tts"
          ? "alba"
          : "af_heart"),
    kokoroModel: tts.kokoroModel ?? (ttsProvider === "openai"
      ? "gpt-4o-mini-tts"
      : ttsProvider === "speaches-kokoro"
        ? "speaches-ai/Kokoro-82M-v1.0-ONNX"
        : ttsProvider === "piper"
          ? "speaches-ai/piper-en_US-lessac-medium"
          : ttsProvider === "pocket-tts"
            ? "pocket-tts"
            : "kokoro"),
    ttsSpeed,
    voiceWaitMs,
    recorderCommand: file.recorderCommand ?? "parecord",
    recorderDevice: file.recorderDevice ?? "default",
    recorderAdditionalArgs: file.recorderAdditionalArgs ?? [],
    playerCommand: file.playerCommand ?? "paplay",
    playerAdditionalArgs: file.playerAdditionalArgs ?? [],
    host: file.host ?? "127.0.0.1",
    port: file.port ?? 45839,
  };
};
