import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { ConverseService } from "./service.js";

type ServiceInternals = {
  transcribe(audio: Buffer): Promise<string>;
  synthesize(text: string): Promise<Buffer>;
};

const serviceWithKey = (): ServiceInternals => {
  const service = new ConverseService({ ...loadConfig(), apiKey: "test-key" }, "test-owner");
  return service as unknown as ServiceInternals;
};

afterEach(() => vi.unstubAllGlobals());

describe("ConverseService API authentication", () => {
  it("sends the API key with multipart transcription requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "hello" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await serviceWithKey().transcribe(Buffer.alloc(960));

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer test-key");
    expect(request.body).toBeInstanceOf(FormData);
  });

  it("sends the API key with JSON speech requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from("wav"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await serviceWithKey().synthesize("hello");

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(request.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(request.body as string)).toMatchObject({ speed: 1.25 });
  });

  it("identifies the backend and preserves a failed API response's detail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), { status: 429 })));

    await expect(serviceWithKey().transcribe(Buffer.alloc(960))).rejects.toThrow(
      'OpenAI transcription request failed: 429: {"error":{"message":"Rate limit reached"}}',
    );
  });
});
