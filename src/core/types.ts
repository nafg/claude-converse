export interface TranscriptEntry {
  id: number;
  final: boolean;
  ts: number;
  text: string;
}

export interface PartialTranscriptEvent {
  type: "partial-transcript";
  entry: TranscriptEntry;
}

export interface FinalTranscriptEvent {
  type: "final-transcript";
  entry: TranscriptEntry;
}

export interface BargeInEvent {
  type: "barge-in";
}

export type ServiceEvent = PartialTranscriptEvent | FinalTranscriptEvent | BargeInEvent;

export interface SpeechChunk {
  text: string;
  pauseSeconds: number;
}
