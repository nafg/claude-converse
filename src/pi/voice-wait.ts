export type VoiceWaitOutcome = "continued" | "timeout" | "cancelled";

interface Waiter {
  baseline: number;
  finish(outcome: VoiceWaitOutcome): void;
}

export class VoiceWaitCoordinator {
  private transcriptVersion = 0;
  private turnTranscriptVersion = 0;
  private readonly waiters = new Set<Waiter>();

  noteTranscript(): void {
    this.transcriptVersion += 1;
    for (const waiter of this.waiters) {
      if (this.transcriptVersion > waiter.baseline) waiter.finish("continued");
    }
  }

  beginTurn(): void {
    this.turnTranscriptVersion = this.transcriptVersion;
  }

  wait(timeoutMs: number, signal?: AbortSignal): Promise<VoiceWaitOutcome> {
    const baseline = this.turnTranscriptVersion;
    if (this.transcriptVersion > baseline) return Promise.resolve("continued");
    if (signal?.aborted) return Promise.resolve("cancelled");

    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: VoiceWaitOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        this.waiters.delete(waiter);
        resolve(outcome);
      };
      const waiter: Waiter = { baseline, finish };
      const onAbort = () => finish("cancelled");
      const timeout = setTimeout(() => finish("timeout"), timeoutMs);
      this.waiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  cancel(): void {
    for (const waiter of this.waiters) waiter.finish("cancelled");
  }
}
