import type { ModSetup } from "../mod/setup";
import type { InputSettings } from "../synth/noteinput";
import { loadUserSlot, Zone } from "../sampler/base";
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
  | { type: "midi"; track: number; status: number; d1: number; d2: number }
  | { type: "liveMix"; dist: number; chorus: number; delay: number; reverb: number }
  | { type: "liveMod"; mod: ModSetup | undefined }
  | { type: "perf"; effect: number; down: boolean }
  | { type: "perfK"; index: number; value: number }
  | { type: "perfLatch"; on: boolean }
  | { type: "perfKill" }
  | { type: "punch"; fx: number }
  | { type: "punchSong"; fx: number }
  | { type: "liveInput"; settings: InputSettings }
  | { type: "userSample"; slot: number; zones: Zone[] | null; data?: Uint8Array }
  | { type: "clockMode"; mode: number }
  | { type: "clock"; status: number }
  | { type: "midiIn"; status: number; d1: number; d2: number }
  | { type: "midiRoute"; route: number }
  | { type: "learn"; track: number; param: number }
  | { type: "learnMap"; map: { cc: number; track: number; param: number }[] }
  | { type: "play" }
  | { type: "stop" };

class SynthProcessor extends AudioWorkletProcessor {
  private engine = createEngine(sampleRate, defaultSong(), factoryInstrument);

  constructor() {
    super();
    this.engine.onTempo = (bpm) => this.port.postMessage({ type: "tempo", bpm });
    this.engine.liveInput.onChord = (c) => { if (c.notes.length > 1 || c.chrd === 11) this.port.postMessage({ type: "chord", ...c }); };
    this.engine.onLearned = (cc, track, param) => this.port.postMessage({ type: "learned", cc, track, param });
    this.engine.onStep = (pattern, step, arrPos) => this.port.postMessage({ type: "pos", pattern, step, arrPos });
    this.engine.onTrackStep = (track, pattern, step, arrPos) => this.port.postMessage({ type: "tpos", track, pattern, step, arrPos });
    this.port.onmessage = (e: MessageEvent<Msg>) => {
      const m = e.data;
      const en = this.engine;
      switch (m.type) {
        case "noteOn": en.liveInput.noteOn(m.note, m.vel ?? 100); break;
        case "noteOff": en.liveInput.noteOff(m.note); break;
        case "liveInput": en.liveInput.set(m.settings); break;
        case "instrument": en.setInstrument(-1, m.instrument); break;
        case "trackInstrument": en.setInstrument(m.track, m.instrument); break;
        case "trackNoteOn": en.tracks[m.track]?.synth.noteOn(m.note, m.vel ?? 100); break;
        case "trackNoteOff": en.tracks[m.track]?.synth.noteOff(m.note); break;
        case "song":
          en.setSong(m.song);
          m.instruments?.forEach((inst, i) => en.setInstrument(i, inst));
          break;
        case "mode": en.mode = m.mode; en.patternIndex = m.pattern; break;
        case "midi": en.midi(m.track, m.status, m.d1, m.d2); break;
        case "liveMix": en.liveMix = { ...en.liveMix, dist: m.dist, chorus: m.chorus, delay: m.delay, reverb: m.reverb }; break;
        case "liveMod": en.liveMod = m.mod; en.live.setMod?.(m.mod); break;
        case "perf": en.perform.press(m.effect, m.down); break;
        case "perfK": en.perform.k[m.index] = m.value; break;
        case "perfLatch": en.perform.latchOn = m.on; break;
        case "perfKill": en.perform.allOff(); break;
        case "punch": en.punch(m.fx); break;
        case "punchSong": en.punchSong(m.fx); break;
        case "userSample": loadUserSlot(m.slot, m.zones && m.data ? { zones: m.zones, data: m.data } : null); break;
        case "clockMode": en.setClockMode(m.mode); break;
        case "clock": if (m.status === 0xf8) en.clockPulse(); else en.clockTransport(m.status); break;
        case "midiIn": en.midiIn(m.status, m.d1, m.d2); break;
        case "midiRoute": en.midiRoute = m.route; break;
        case "learn": en.learn(m.track, m.param); break;
        case "learnMap": en.learnMap = m.map; break;
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
