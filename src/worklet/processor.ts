import { factoryPatches } from "../fm6/library";
import { Fm6Voice } from "../fm6/note";

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: unknown): void;

class SynthProcessor extends AudioWorkletProcessor {
  private voice = new Fm6Voice(factoryPatches[1].patch);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; note?: number; patch?: Uint8Array };
      if (m.type === "noteOn") this.voice.noteOn(m.note ?? 60);
      else if (m.type === "noteOff") this.voice.noteOff();
      else if (m.type === "patch" && m.patch) this.voice.setPatch(m.patch);
    };
  }

  process(_in: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) out[i] = this.voice.next();
    return true;
  }
}

registerProcessor("synth", SynthProcessor);
