import type { ConverseConfig } from "./config.js";

export type VadEmission =
  | { type: "speech-start"; utteranceId: number }
  | { type: "partial"; utteranceId: number; audio: Buffer }
  | { type: "final"; utteranceId: number; audio: Buffer }
  | { type: "barge-in" };

export class EnergyVad {
  private readonly frameBytes: number;
  private readonly preBuffer: Buffer[] = [];
  private readonly speechFrames: Buffer[] = [];
  private consecutiveSpeech = 0;
  private consecutiveSilence = 0;
  private consecutiveLoud = 0;
  private inSpeech = false;
  private chunkEmitted = false;
  private ttsKilled = false;
  private utteranceId = 0;

  constructor(private readonly config: ConverseConfig) {
    this.frameBytes = Math.floor((config.sampleRate * config.frameDurationMs) / 1000) * config.bytesPerSample * config.channels;
  }

  getFrameBytes(): number {
    return this.frameBytes;
  }

  pushFrame(frame: Buffer): VadEmission[] {
    const emissions: VadEmission[] = [];
    const rms = this.computeRms(frame);
    const isSpeech = rms > this.config.vadThreshold;
    const isLoud = rms > this.config.vadThreshold * this.config.vadBargeInEnergyMultiplier;

    if (isLoud) {
      this.consecutiveLoud += 1;
      if (this.consecutiveLoud >= this.config.vadBargeInFrames && !this.ttsKilled) {
        this.ttsKilled = true;
        emissions.push({ type: "barge-in" });
      }
    } else {
      if (this.consecutiveLoud > 0) this.ttsKilled = false;
      this.consecutiveLoud = 0;
    }

    if (!this.inSpeech) {
      this.pushPreBuffer(frame);
      if (isSpeech) {
        this.consecutiveSpeech += 1;
        if (this.consecutiveSpeech >= this.config.vadSpeechStartFrames) {
          this.inSpeech = true;
          this.consecutiveSilence = 0;
          this.chunkEmitted = false;
          this.utteranceId += 1;
          this.speechFrames.splice(0, this.speechFrames.length, ...this.preBuffer);
          this.preBuffer.length = 0;
          emissions.push({ type: "speech-start", utteranceId: this.utteranceId });
        }
      } else {
        this.consecutiveSpeech = 0;
      }
      return emissions;
    }

    this.speechFrames.push(frame);
    if (isSpeech) {
      this.consecutiveSilence = 0;
      this.chunkEmitted = false;
    } else {
      this.consecutiveSilence += 1;
    }

    if (
      !this.chunkEmitted &&
      this.consecutiveSilence === this.config.vadChunkSilenceFrames &&
      this.speechFrames.length >= this.config.vadMinUtteranceFrames
    ) {
      this.chunkEmitted = true;
      emissions.push({ type: "partial", utteranceId: this.utteranceId, audio: Buffer.concat(this.speechFrames) });
    }

    if (this.consecutiveSilence >= this.config.vadUtteranceEndFrames) {
      this.inSpeech = false;
      this.consecutiveSpeech = 0;
      this.consecutiveSilence = 0;
      this.ttsKilled = false;
      if (this.speechFrames.length >= this.config.vadMinUtteranceFrames) {
        emissions.push({ type: "final", utteranceId: this.utteranceId, audio: Buffer.concat(this.speechFrames) });
      }
      this.speechFrames.length = 0;
      this.chunkEmitted = false;
    }

    return emissions;
  }

  private pushPreBuffer(frame: Buffer): void {
    this.preBuffer.push(frame);
    while (this.preBuffer.length > this.config.vadPreBufferFrames) this.preBuffer.shift();
  }

  private computeRms(frame: Buffer): number {
    let sumSquares = 0;
    for (let offset = 0; offset < frame.length; offset += 2) {
      const sample = frame.readInt16LE(offset);
      sumSquares += sample * sample;
    }
    const count = frame.length / 2;
    return Math.sqrt(sumSquares / count);
  }
}
