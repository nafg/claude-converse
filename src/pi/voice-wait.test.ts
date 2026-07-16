import { describe, expect, it } from "vitest";
import { VoiceWaitCoordinator } from "./voice-wait.js";

describe("VoiceWaitCoordinator", () => {
  it("returns immediately when continuation arrived during the current turn", async () => {
    const coordinator = new VoiceWaitCoordinator();
    coordinator.noteTranscript();
    coordinator.beginTurn();
    coordinator.noteTranscript();

    await expect(coordinator.wait(50)).resolves.toBe("continued");
  });

  it("wakes when continuation arrives while waiting", async () => {
    const coordinator = new VoiceWaitCoordinator();
    coordinator.noteTranscript();
    coordinator.beginTurn();

    const waiting = coordinator.wait(100);
    coordinator.noteTranscript();

    await expect(waiting).resolves.toBe("continued");
  });

  it("times out when the user does not continue", async () => {
    const coordinator = new VoiceWaitCoordinator();
    coordinator.noteTranscript();
    coordinator.beginTurn();

    await expect(coordinator.wait(1)).resolves.toBe("timeout");
  });
});
