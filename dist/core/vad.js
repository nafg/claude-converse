export class EnergyVad {
    config;
    frameBytes;
    preBuffer = [];
    speechFrames = [];
    consecutiveSpeech = 0;
    consecutiveSilence = 0;
    consecutiveLoud = 0;
    inSpeech = false;
    chunkEmitted = false;
    ttsKilled = false;
    utteranceId = 0;
    constructor(config) {
        this.config = config;
        this.frameBytes = Math.floor((config.sampleRate * config.frameDurationMs) / 1000) * config.bytesPerSample * config.channels;
    }
    getFrameBytes() {
        return this.frameBytes;
    }
    pushFrame(frame) {
        const emissions = [];
        const rms = this.computeRms(frame);
        const isSpeech = rms > this.config.vadThreshold;
        const isLoud = rms > this.config.vadThreshold * this.config.vadBargeInEnergyMultiplier;
        if (isLoud) {
            this.consecutiveLoud += 1;
            if (this.consecutiveLoud >= this.config.vadBargeInFrames && !this.ttsKilled) {
                this.ttsKilled = true;
                emissions.push({ type: "barge-in" });
            }
        }
        else {
            if (this.consecutiveLoud > 0)
                this.ttsKilled = false;
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
            }
            else {
                this.consecutiveSpeech = 0;
            }
            return emissions;
        }
        this.speechFrames.push(frame);
        if (isSpeech) {
            this.consecutiveSilence = 0;
            this.chunkEmitted = false;
        }
        else {
            this.consecutiveSilence += 1;
        }
        if (!this.chunkEmitted &&
            this.consecutiveSilence === this.config.vadChunkSilenceFrames &&
            this.speechFrames.length >= this.config.vadMinUtteranceFrames) {
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
    pushPreBuffer(frame) {
        this.preBuffer.push(frame);
        while (this.preBuffer.length > this.config.vadPreBufferFrames)
            this.preBuffer.shift();
    }
    computeRms(frame) {
        let sumSquares = 0;
        for (let offset = 0; offset < frame.length; offset += 2) {
            const sample = frame.readInt16LE(offset);
            sumSquares += sample * sample;
        }
        const count = frame.length / 2;
        return Math.sqrt(sumSquares / count);
    }
}
