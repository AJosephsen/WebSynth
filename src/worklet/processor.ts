import { factoryInstrument } from "../instruments";
import { createEngine } from "../seq/engine";
import { defaultSong, Song } from "../seq/song";
import { Instrument } from "../synth/synth";

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: unknown): void;

type Msg =
  | { type: "noteOn"; note: number; vel?: number }
  | { type: "noteOff"; note: number }
  | { type: "instrument"; instrument: Instrument }
  | { type: "trackInstrument"; track: number; instrument: Instrument }
  | { type: "trackNoteOn"; track: number; note: number; vel?: number }
  | { type: "trackNoteOff"; track: number; note: number }
  | { type: "song"; song: Song; instruments?: Instrument[] }
  | { type: "mode"; mode: "pattern" | "song"; pattern: number }
  | { type: "play" }
  | { type: "stop" };

class SynthProcessor extends AudioWorkletProcessor {
  private engine = createEngine(sampleRate, defaultSong(), factoryInstrument);

  constructor() {
    super();
    this.engine.onStep = (pattern, step, arrPos) => this.port.postMessage({ type: "pos", pattern, step, arrPos });
    this.port.onmessage = (e: MessageEvent<Msg>) => {
      const m = e.data;
      const en = this.engine;
      switch (m.type) {
        case "noteOn": en.live.noteOn(m.note, m.vel ?? 100); break;
        case "noteOff": en.live.noteOff(m.note); break;
        case "instrument": en.setInstrument(-1, m.instrument); break;
        case "trackInstrument": en.setInstrument(m.track, m.instrument); break;
        case "trackNoteOn": en.tracks[m.track]?.synth.noteOn(m.note, m.vel ?? 100); break;
        case "trackNoteOff": en.tracks[m.track]?.synth.noteOff(m.note); break;
        case "song":
          en.setSong(m.song);
          m.instruments?.forEach((inst, i) => en.setInstrument(i, inst));
          break;
        case "mode": en.mode = m.mode; en.patternIndex = m.pattern; break;
        case "play": en.play(); break;
        case "stop": en.stop(); this.port.postMessage({ type: "stopped" }); break;
      }
    };
  }

  private spare = new Float32Array(128);

  process(_in: Float32Array[][], outputs: Float32Array[][]): boolean {
    const [l, r] = outputs[0];
    this.engine.renderStereo(l, r ?? this.spare.subarray(0, l.length));
    return true;
  }
}

registerProcessor("synth", SynthProcessor);
