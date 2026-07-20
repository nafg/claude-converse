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
