import { describe, expect, it } from "vitest";
import { speakableText, splitSpeechChunks, stripEchoPrefix, wrapLines } from "./text.js";

describe("stripEchoPrefix", () => {
  it("strips a well-formed transcribed wrapper on separate lines", () => {
    expect(stripEchoPrefix("[transcribed]\nhello\n[/transcribed]\n\nresponse")).toBe("response");
  });

  it("strips an inline transcribed wrapper", () => {
    expect(stripEchoPrefix("[transcribed] hello there [/transcribed] the response")).toBe("the response");
  });

  it("strips a wrapper with leading whitespace", () => {
    expect(stripEchoPrefix("  [transcribed] hi [/transcribed]\nresponse")).toBe("response");
  });

  it("still strips the legacy heard wrapper", () => {
    expect(stripEchoPrefix("[heard]\nhello\n[/heard]\n\nresponse")).toBe("response");
  });

  it("fails open on malformed wrapper (no closer)", () => {
    const text = "[heard]\nhello\nresponse";
    expect(stripEchoPrefix(text)).toBe(text);
  });

  it("leaves text without a leading wrapper untouched", () => {
    const text = "just a normal reply [transcribed] not at the start [/transcribed]";
    expect(stripEchoPrefix(text)).toBe(text);
  });
});

describe("wrapLines", () => {
  it("leaves short text as a single line", () => {
    expect(wrapLines("a short transcript", 400)).toEqual(["a short transcript"]);
  });

  it("wraps on word boundaries without exceeding the width or losing words", () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`);
    const lines = wrapLines(words.join(" "), 40);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
    expect(lines.join(" ")).toBe(words.join(" "));
    expect(lines.length).toBeGreaterThan(1);
  });

  it("hard-splits a single word longer than the width", () => {
    const lines = wrapLines("x".repeat(90), 40);
    expect(lines).toEqual(["x".repeat(40), "x".repeat(40), "x".repeat(10)]);
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
