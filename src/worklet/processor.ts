import { Operator } from "../dsp/operator";

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: unknown): void;

class SynthProcessor extends AudioWorkletProcessor {
  private op = new Operator(sampleRate);
  private gate = 0;
  private gain = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; freq?: number };
      if (m.type === "noteOn") {
        this.op.frequency = m.freq ?? 440;
        this.gate = 1;
      } else if (m.type === "noteOff") {
        this.gate = 0;
      }
    };
  }

  process(_in: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0][0];
    const slew = 1 / (0.005 * sampleRate); // 5 ms ramp, avoids clicks
    for (let i = 0; i < out.length; i++) {
      this.gain += Math.max(-slew, Math.min(slew, this.gate - this.gain));
      out[i] = this.op.next() * this.gain * 0.5;
    }
    return true;
  }
}

registerProcessor("synth", SynthProcessor);
