import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { ConverseService } from "./service.js";

type ServiceInternals = {
  transcribe(audio: Buffer): Promise<string>;
  synthesize(text: string): Promise<Buffer>;
};

const openAiConfig = () => ({
  ...loadConfig(),
  sttProvider: "openai" as const,
  ttsProvider: "openai" as const,
  voiceProvider: "openai" as const,
  sttApiKey: "stt-key",
  ttsApiKey: "tts-key",
  apiKey: undefined,
});

const serviceWithKey = (): ServiceInternals => {
  const service = new ConverseService(openAiConfig(), "test-owner");
  return service as unknown as ServiceInternals;
};

const whisperCppConfig = () => ({
  ...openAiConfig(),
  sttProvider: "whisper.cpp" as const,
  ttsProvider: "local" as const,
  voiceProvider: "local" as const,
  sttApiKey: undefined,
  ttsApiKey: undefined,
  whisperUrl: "http://localhost:2022/v1/audio/transcriptions",
  whisperModel: "base.en",
  whisperLanguage: "en",
  whisperPrompt: "Programming terms",
});

const kokoroConfig = () => ({
  ...whisperCppConfig(),
  ttsProvider: "kokoro" as const,
  kokoroUrl: "http://localhost:8880/v1/audio/speech",
  kokoroModel: "kokoro",
  kokoroVoice: "af_heart",
});

const speachesKokoroConfig = (ttsApiKey?: string) => ({
  ...whisperCppConfig(),
  ttsProvider: "speaches-kokoro" as const,
  ttsApiKey,
  kokoroUrl: "http://localhost:8000/v1/audio/speech",
  kokoroModel: "speaches-ai/Kokoro-82M-v1.0-ONNX",
  kokoroVoice: "af_heart",
  ttsSpeed: 1.25,
});

const piperConfig = (ttsApiKey?: string) => ({
  ...whisperCppConfig(),
  ttsProvider: "piper" as const,
  ttsApiKey,
  kokoroUrl: "http://localhost:8000/v1/audio/speech",
  kokoroModel: "speaches-ai/piper-en_US-lessac-medium",
  kokoroVoice: "lessac",
  ttsSpeed: 1.25,
});

const pocketTtsConfig = () => ({
  ...whisperCppConfig(),
  ttsProvider: "pocket-tts" as const,
  ttsApiKey: undefined,
  kokoroUrl: "http://localhost:8000/tts",
  kokoroModel: "pocket-tts",
  kokoroVoice: "alba",
});

const groqConfig = () => ({
  ...kokoroConfig(),
  sttProvider: "groq" as const,
  sttApiKey: "groq-key",
  whisperUrl: "https://api.groq.com/openai/v1/audio/transcriptions",
  whisperModel: "whisper-large-v3-turbo",
  whisperLanguage: "en",
  whisperPrompt: "Programming terms",
});

const speachesConfig = (sttApiKey?: string) => ({
  ...kokoroConfig(),
  sttProvider: "speaches" as const,
  sttApiKey,
  whisperUrl: "http://localhost:8000/v1/audio/transcriptions",
  whisperModel: "Systran/faster-distil-whisper-small.en",
  whisperLanguage: "en",
  whisperPrompt: "Programming terms",
});

afterEach(() => vi.unstubAllGlobals());

describe("ConverseService API authentication", () => {
  it("sends only the STT API key with multipart transcription requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "hello" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await serviceWithKey().transcribe(Buffer.alloc(960));

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer stt-key");
    expect(request.body).toBeInstanceOf(FormData);
  });

  it("sends whisper.cpp its configurable multipart fields without authorization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "hello" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConverseService(whisperCppConfig(), "test-owner") as unknown as ServiceInternals;

    await service.transcribe(Buffer.alloc(960));

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:2022/v1/audio/transcriptions");
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("authorization")).toBeNull();
    const form = request.body as FormData;
    expect(form.get("model")).toBe("base.en");
    expect(form.get("language")).toBe("en");
    expect(form.get("prompt")).toBe("Programming terms");
  });

  it("sends Groq its supported multipart fields and only the STT key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "hello" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConverseService(groqConfig(), "test-owner") as unknown as ServiceInternals;

    await service.transcribe(Buffer.alloc(960));

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer groq-key");
    const form = request.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect(form.get("response_format")).toBe("json");
    expect(form.get("language")).toBe("en");
    expect(form.get("prompt")).toBe("Programming terms");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("sends Speaches configurable multipart fields and its optional local key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "hello" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConverseService(speachesConfig("local-secret"), "test-owner") as unknown as ServiceInternals;

    await service.transcribe(Buffer.alloc(960));

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:8000/v1/audio/transcriptions");
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer local-secret");
    const form = request.body as FormData;
    expect(form.get("model")).toBe("Systran/faster-distil-whisper-small.en");
    expect(form.get("response_format")).toBe("json");
    expect(form.get("language")).toBe("en");
    expect(form.get("prompt")).toBe("Programming terms");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("keeps keyless Speaches requests unauthenticated", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "hello" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConverseService(speachesConfig(), "test-owner") as unknown as ServiceInternals;

    await service.transcribe(Buffer.alloc(960));

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("authorization")).toBeNull();
  });

  it("never attaches a Speaches STT key to Kokoro speech", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from("wav"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConverseService(speachesConfig("local-secret"), "test-owner") as unknown as ServiceInternals;

    await service.synthesize("hello");

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("authorization")).toBeNull();
  });

  it("never attaches the Groq STT key to Kokoro speech", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from("wav"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConverseService(groqConfig(), "test-owner") as unknown as ServiceInternals;

    await service.synthesize("hello");

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("authorization")).toBeNull();
  });

  it("identifies Groq transcription failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("rate limit", { status: 429 })));
    const service = new ConverseService(groqConfig(), "test-owner") as unknown as ServiceInternals;

    await expect(service.transcribe(Buffer.alloc(960))).rejects.toThrow(
      "Groq transcription request failed: 429: rate limit",
    );
  });

  it("identifies Speaches transcription failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("model unavailable", { status: 503 })));
    const service = new ConverseService(speachesConfig(), "test-owner") as unknown as ServiceInternals;

    await expect(service.transcribe(Buffer.alloc(960))).rejects.toThrow(
      "Speaches transcription request failed: 503: model unavailable",
    );
  });

  it("identifies whisper.cpp transcription failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("model unavailable", { status: 503 })));
    const service = new ConverseService(whisperCppConfig(), "test-owner") as unknown as ServiceInternals;

    await expect(service.transcribe(Buffer.alloc(960))).rejects.toThrow(
      "whisper.cpp transcription request failed: 503: model unavailable",
    );
  });

  it("sends only the TTS API key with JSON speech requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from("wav"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await serviceWithKey().synthesize("hello");

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(request.headers);
    expect(headers.get("authorization")).toBe("Bearer tts-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(request.body as string)).toMatchObject({ speed: 1.25 });
  });

  it("sends Kokoro its configurable speech request without authorization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from("wav"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConverseService(kokoroConfig(), "test-owner") as unknown as ServiceInternals;

    await service.synthesize("hello");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:8880/v1/audio/speech");
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(request.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(request.body as string)).toEqual({
      model: "kokoro",
      input: "hello",
      voice: "af_heart",
      response_format: "wav",
    });
  });

  it("sends Speaches Kokoro ONNX its configurable request and optional local TTS key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from("wav"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConverseService(speachesKokoroConfig("local-secret"), "test-owner") as unknown as ServiceInternals;

    await service.synthesize("hello");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:8000/v1/audio/speech");
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(request.headers);
    expect(headers.get("authorization")).toBe("Bearer local-secret");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(request.body as string)).toEqual({
      model: "speaches-ai/Kokoro-82M-v1.0-ONNX",
      input: "hello",
      voice: "af_heart",
      response_format: "wav",
      speed: 1.25,
    });
  });

  it("sends Speaches Piper its verified model, voice, speed, and optional local key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from("wav"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConverseService(piperConfig("local-secret"), "test-owner") as unknown as ServiceInternals;

    await service.synthesize("hello");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:8000/v1/audio/speech");
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(request.headers);
    expect(headers.get("authorization")).toBe("Bearer local-secret");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(request.body as string)).toEqual({
      model: "speaches-ai/piper-en_US-lessac-medium",
      input: "hello",
      voice: "lessac",
      response_format: "wav",
      speed: 1.25,
    });
  });

  it("uses the official Pocket TTS multipart API without credentials or OpenAI fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from("wav"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConverseService(pocketTtsConfig(), "test-owner") as unknown as ServiceInternals;

    await service.synthesize("hello");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:8000/tts");
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(request.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("content-type")).toBeNull();
    const form = request.body as FormData;
    expect(form.get("text")).toBe("hello");
    expect(form.get("voice_url")).toBe("alba");
    expect([...form.keys()].sort()).toEqual(["text", "voice_url"]);
  });

  it("keeps keyless Speaches Piper speech unauthenticated and its TTS key off STT", async () => {
    const speechFetch = vi.fn().mockResolvedValue(new Response(Buffer.from("wav"), { status: 200 }));
    vi.stubGlobal("fetch", speechFetch);
    const keylessService = new ConverseService(piperConfig(), "test-owner") as unknown as ServiceInternals;
    await keylessService.synthesize("hello");
    expect(new Headers((speechFetch.mock.calls[0]?.[1] as RequestInit).headers).get("authorization")).toBeNull();

    const transcriptionFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "hello" }), { status: 200 }));
    vi.stubGlobal("fetch", transcriptionFetch);
    const keyedService = new ConverseService(piperConfig("local-secret"), "test-owner") as unknown as ServiceInternals;
    await keyedService.transcribe(Buffer.alloc(960));
    expect(new Headers((transcriptionFetch.mock.calls[0]?.[1] as RequestInit).headers).get("authorization")).toBeNull();
  });

  it("keeps keyless Speaches Kokoro ONNX speech requests unauthenticated", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from("wav"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConverseService(speachesKokoroConfig(), "test-owner") as unknown as ServiceInternals;

    await service.synthesize("hello");

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("authorization")).toBeNull();
  });

  it("keeps a Speaches Kokoro TTS key off transcription requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "hello" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConverseService(speachesKokoroConfig("local-secret"), "test-owner") as unknown as ServiceInternals;

    await service.transcribe(Buffer.alloc(960));

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("authorization")).toBeNull();
  });

  it("identifies Speaches Kokoro ONNX speech failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("model unavailable", { status: 503 })));
    const service = new ConverseService(speachesKokoroConfig(), "test-owner") as unknown as ServiceInternals;

    await expect(service.synthesize("hello")).rejects.toThrow(
      "Speaches Kokoro ONNX speech request failed: 503: model unavailable",
    );
  });

  it("identifies Speaches Piper speech failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("model unavailable", { status: 503 })));
    const service = new ConverseService(piperConfig(), "test-owner") as unknown as ServiceInternals;

    await expect(service.synthesize("hello")).rejects.toThrow(
      "Speaches Piper speech request failed: 503: model unavailable",
    );
  });

  it("identifies official Pocket TTS speech failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("model unavailable", { status: 503 })));
    const service = new ConverseService(pocketTtsConfig(), "test-owner") as unknown as ServiceInternals;

    await expect(service.synthesize("hello")).rejects.toThrow(
      "Pocket TTS speech request failed: 503: model unavailable",
    );
  });

  it("identifies Kokoro speech failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("model unavailable", { status: 503 })));
    const service = new ConverseService(kokoroConfig(), "test-owner") as unknown as ServiceInternals;

    await expect(service.synthesize("hello")).rejects.toThrow(
      "Kokoro speech request failed: 503: model unavailable",
    );
  });

  it("identifies the backend and preserves a failed API response's detail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), { status: 429 })));

    await expect(serviceWithKey().transcribe(Buffer.alloc(960))).rejects.toThrow(
      'OpenAI transcription request failed: 429: {"error":{"message":"Rate limit reached"}}',
    );
  });

  it("does not synthesize text removed entirely by speech cleanup", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConverseService(openAiConfig(), "test-owner");

    await expect(service.speak("---", "test-owner")).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts an in-flight hosted synthesis when speaking stops", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConverseService(openAiConfig(), "test-owner");

    void service.speak("Still synthesizing.", "test-owner");
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    service.stopSpeaking();

    expect(requestSignal?.aborted).toBe(true);
  });

  it("aborts in-flight Kokoro synthesis when speaking stops", async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    }));
    const service = new ConverseService(kokoroConfig(), "test-owner");

    void service.speak("Still synthesizing.", "test-owner");
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    service.stopSpeaking();

    expect(requestSignal?.aborted).toBe(true);
  });

  it("keeps long Kokoro replies chunked through the common service path", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(Buffer.from("wav"), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConverseService(kokoroConfig(), "test-owner");
    (service as unknown as { playWav: () => Promise<void> }).playWav = async () => undefined;

    await service.speak("First sentence. Second sentence.", "test-owner");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const spoken = fetchMock.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string).input);
    expect(spoken).toEqual(["First sentence.", "Second sentence."]);
  });

  it("starts Pocket TTS playback from the response stream without buffering the whole WAV", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    const service = new ConverseService(pocketTtsConfig(), "test-owner");
    let firstAudio: Uint8Array | undefined;
    (service as unknown as { playWavStream: (response: Response) => Promise<void> }).playWavStream = async (response) => {
      const reader = response.body!.getReader();
      firstAudio = (await reader.read()).value;
      await reader.cancel();
    };

    await expect(service.speak("Stream this response.", "test-owner")).resolves.toBe(true);

    expect(firstAudio).toEqual(new Uint8Array([1, 2, 3]));
    expect(streamController).toBeDefined();
  });

  it("aborts an in-flight Pocket TTS request when speaking stops", async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    }));
    const service = new ConverseService(pocketTtsConfig(), "test-owner");

    void service.speak("Still synthesizing.", "test-owner");
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    service.stopSpeaking();

    expect(requestSignal?.aborted).toBe(true);
  });

  it("keeps long Pocket TTS replies sentence-chunked while streaming each response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from("wav"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConverseService(pocketTtsConfig(), "test-owner");
    (service as unknown as { playWavStream: () => Promise<void> }).playWavStream = async () => undefined;

    await service.speak("First sentence. Second sentence.", "test-owner");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const spoken = fetchMock.mock.calls.map((call) => ((call[1] as RequestInit).body as FormData).get("text"));
    expect(spoken).toEqual(["First sentence.", "Second sentence."]);
  });

  it("aborts in-flight Piper synthesis when speaking stops", async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    }));
    const service = new ConverseService(piperConfig(), "test-owner");

    void service.speak("Still synthesizing.", "test-owner");
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    service.stopSpeaking();

    expect(requestSignal?.aborted).toBe(true);
  });

  it("keeps long Piper replies chunked through the common service path", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(Buffer.from("wav"), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConverseService(piperConfig(), "test-owner");
    (service as unknown as { playWav: () => Promise<void> }).playWav = async () => undefined;

    await service.speak("First sentence. Second sentence.", "test-owner");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const spoken = fetchMock.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string).input);
    expect(spoken).toEqual(["First sentence.", "Second sentence."]);
  });

  it("keeps long Speaches Kokoro replies chunked through the common service path", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(Buffer.from("wav"), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConverseService(speachesKokoroConfig(), "test-owner");
    (service as unknown as { playWav: () => Promise<void> }).playWav = async () => undefined;

    await service.speak("First sentence. Second sentence.", "test-owner");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const spoken = fetchMock.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string).input);
    expect(spoken).toEqual(["First sentence.", "Second sentence."]);
  });

  it("prefetches the next hosted sentence before playing the current one", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(Buffer.from("wav"), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConverseService(openAiConfig(), "test-owner");
    let requestsAtFirstPlayback = 0;
    (service as unknown as { playWav: () => Promise<void> }).playWav = async () => {
      if (requestsAtFirstPlayback === 0) requestsAtFirstPlayback = fetchMock.mock.calls.length;
    };

    await service.speak("First sentence. Second sentence.", "test-owner");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestsAtFirstPlayback).toBe(2);
  });
});
