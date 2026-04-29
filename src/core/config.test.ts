import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

afterEach(() => {
  delete process.env.CONVERSE_PORT;
  delete process.env.VAD_BARGE_IN_ENERGY_MULT;
  delete process.env.CONVERSE_BYTES_PER_SAMPLE;
});

describe("loadConfig", () => {
  it("falls back on invalid numeric env vars", () => {
    process.env.CONVERSE_PORT = "abc";
    process.env.VAD_BARGE_IN_ENERGY_MULT = "nan";
    const config = loadConfig();
    expect(config.port).toBe(45839);
    expect(config.vadBargeInEnergyMultiplier).toBe(2);
  });

  it("rejects unsupported bytes-per-sample values", () => {
    process.env.CONVERSE_BYTES_PER_SAMPLE = "4";
    expect(() => loadConfig()).toThrow(/unsupported/);
  });
});
