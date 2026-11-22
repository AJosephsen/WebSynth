import { patches } from "../dsp/patches";
import { Voice } from "../dsp/voice";

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: unknown): void;

class SynthProcessor extends AudioWorkletProcessor {
  private voice = new Voice(sampleRate, patches.epiano);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; freq?: number };
      if (m.type === "noteOn") this.voice.noteOn(m.freq ?? 440);
      else if (m.type === "noteOff") this.voice.noteOff();
    };
  }

  process(_in: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      out[i] = this.voice.next() * 0.4;
    }
    return true;
  }
}

registerProcessor("synth", SynthProcessor);
