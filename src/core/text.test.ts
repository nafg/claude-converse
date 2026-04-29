import { describe, expect, it } from "vitest";
import { speakableText, splitSpeechChunks, stripEchoPrefix } from "./text.js";

describe("stripEchoPrefix", () => {
  it("strips a well-formed transcribed wrapper", () => {
    expect(stripEchoPrefix("[transcribed]\nhello\n[/transcribed]\n\nresponse")).toBe("response");
  });

  it("still strips the legacy heard wrapper", () => {
    expect(stripEchoPrefix("[heard]\nhello\n[/heard]\n\nresponse")).toBe("response");
  });

  it("fails open on malformed wrapper", () => {
    const text = "[heard]\nhello\nresponse";
    expect(stripEchoPrefix(text)).toBe(text);
  });
});

describe("speakableText", () => {
  it("returns null when only wrapper is present", () => {
    expect(speakableText("[transcribed]\nhello\n[/transcribed]\n")).toBeNull();
  });
});

describe("splitSpeechChunks", () => {
  it("splits sentences and keeps last pause at zero", () => {
    const chunks = splitSpeechChunks("Hello world. Second sentence!\n\n- item one\n- item two");
    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "Hello world.",
      "Second sentence!",
      "item one",
      "item two",
    ]);
    expect(chunks.at(-1)?.pauseSeconds).toBe(0);
  });
});
