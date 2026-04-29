import { describe, expect, it } from "vitest";
import type { ConverseConfig } from "./config.js";
import { EnergyVad } from "./vad.js";

const config: ConverseConfig = {
  sampleRate: 16_000,
  channels: 1,
  bytesPerSample: 2,
  frameDurationMs: 30,
  vadThreshold: 100,
  vadSpeechStartFrames: 3,
  vadChunkSilenceFrames: 2,
  vadUtteranceEndFrames: 4,
  vadMinUtteranceFrames: 2,
  vadBargeInEnergyMultiplier: 2,
  vadBargeInFrames: 2,
  vadPreBufferFrames: 2,
  recentMaxEntries: 50,
  statusWindowSeconds: 30,
  statusPrefix: "🎤 ",
  statusSeparator: " | ",
  whisperUrl: "http://localhost",
  whisperModel: "base",
  whisperLanguage: "en",
  whisperPrompt: "",
  kokoroUrl: "http://localhost",
  kokoroVoice: "voice",
  kokoroModel: "model",
  recorderCommand: "arecord",
  recorderDevice: "default",
  recorderAdditionalArgs: [],
  playerCommand: "aplay",
  playerAdditionalArgs: [],
  host: "127.0.0.1",
  port: 45839,
};

const frameOf = (vad: EnergyVad, amplitude: number): Buffer => {
  const frame = Buffer.alloc(vad.getFrameBytes());
  for (let offset = 0; offset < frame.length; offset += 2) frame.writeInt16LE(amplitude, offset);
  return frame;
};

describe("EnergyVad", () => {
  it("emits barge-in separately from speech start", () => {
    const vad = new EnergyVad(config);
    expect(vad.pushFrame(frameOf(vad, 250)).map((event) => event.type)).toEqual([]);
    expect(vad.pushFrame(frameOf(vad, 250)).map((event) => event.type)).toContain("barge-in");
  });

  it("emits partial then final after silence windows", () => {
    const vad = new EnergyVad(config);
    const speech = frameOf(vad, 150);
    const silence = frameOf(vad, 0);

    expect(vad.pushFrame(speech).map((event) => event.type)).toEqual([]);
    expect(vad.pushFrame(speech).map((event) => event.type)).toEqual([]);
    expect(vad.pushFrame(speech).map((event) => event.type)).toContain("speech-start");
    vad.pushFrame(speech);
    expect(vad.pushFrame(silence).map((event) => event.type)).toEqual([]);
    expect(vad.pushFrame(silence).map((event) => event.type)).toContain("partial");
    expect(vad.pushFrame(silence).map((event) => event.type)).toEqual([]);
    expect(vad.pushFrame(silence).map((event) => event.type)).toContain("final");
  });
});
