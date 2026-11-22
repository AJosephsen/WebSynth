import { byName } from "../fm6/library";
import { demos } from "../seq/demos";
import { Engine } from "../seq/engine";
import { PolySynth } from "../synth/poly";

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: unknown): void;

type Msg =
  | { type: "noteOn"; note: number; vel?: number }
  | { type: "noteOff"; note: number }
  | { type: "patch"; patch: Uint8Array }
  | { type: "trackPatch"; track: number; patch: Uint8Array }
  | { type: "demo"; index: number }
  | { type: "play" }
  | { type: "stop" }
  | { type: "bpm"; bpm: number };

class SynthProcessor extends AudioWorkletProcessor {
  private engine = new Engine(sampleRate, new PolySynth(byName("TINE EP").patch, 8));

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<Msg>) => {
      const m = e.data;
      const en = this.engine;
      switch (m.type) {
        case "noteOn": en.live.noteOn(m.note, m.vel ?? 100); break;
        case "noteOff": en.live.noteOff(m.note); break;
        case "patch": en.live.setPatch(m.patch); break;
        case "trackPatch": en.tracks[m.track]?.synth.setPatch(m.patch); break;
        case "demo": {
          const d = demos[m.index];
          en.stop();
          en.tracks = [];
          for (const t of d.tracks) {
            const s = new PolySynth(byName(t.patch).patch, 6);
            s.gain = 0.7;
            en.addTrack(s, t.steps);
          }
          en.bpm = d.bpm;
          en.swing = d.swing;
          break;
        }
        case "play": en.play(); break;
        case "stop": en.stop(); break;
        case "bpm": en.bpm = m.bpm; break;
      }
    };
  }

  process(_in: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0][0];
    out.fill(0);
    this.engine.render(out);
    return true;
  }
}

registerProcessor("synth", SynthProcessor);
