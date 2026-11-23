// A polyphonic synth around one of the ported Felucca engines: voice allocation, ADSR, velocity and the ENV->FLT
// amount, after Felucca's voice.c (GPL-3.0-only). See NOTICE.
import { clamp, mulq15, mulq16, pitchInc } from "../engines/dsp";
import { CTL, EngineDef, EngVoice, FS, P_ATK, P_E0, P_FTYPE, P_REL, Track, Vmod } from "../engines/types";
import type { Instrument, Synth } from "./synth";

// ENV_LIN / ENV_EXP (Felucca's tools/gen_tables.py): a time of 1 ms .. 10 s for a parameter 0..127
const ms = (v: number): number => 1.0 * 10000 ** (v / 127);
const ENV_LIN = Array.from({ length: 128 }, (_, v) => Math.max(1, Math.floor(((1 << 24) * CTL) / ((ms(v) * FS) / 1000))));
const ENV_EXP = Array.from({ length: 128 }, (_, v) => {
  const tau = ms(v) / 1000 / 4.6;
  return Math.max(1, Math.min(65535, Math.floor(65536 * (1 - Math.exp(-CTL / (tau * FS))))));
});

type EngineInstrument = Extract<Instrument, { kind: "engine" }>;

export class EnginePoly implements Synth {
  gain = 1;
  private track = new Track();
  private voices: EngVoice[];
  private env = [0, 70, 100, 40]; // ATK DEC SUS REL
  private fenv = 0;
  private clock = 0;
  private buf = new Int32Array(CTL);
  private pos = CTL;
  private last: Int32Array;

  constructor(private def: EngineDef, inst: EngineInstrument, voices = 8) {
    this.voices = Array.from({ length: voices }, () => new EngVoice());
    this.track.v = this.voices;
    this.last = new Int32Array(voices);
    this.setInstrument(inst);
  }

  setInstrument(inst: EngineInstrument): void {
    const p = this.track.p;
    inst.params.forEach((v, k) => (p[P_E0 + k] = v));
    this.env = [...inst.env];
    p[P_ATK] = this.env[0];
    p[P_REL] = this.env[3];
    p[P_FTYPE] = inst.ftype ?? 0;
    this.fenv = inst.fenv;
  }

  get activeVoices(): number {
    return this.voices.filter((v) => v.active).length;
  }

  noteOn(note: number, velocity = 100): void {
    let v = this.voices.find((x) => x.active && x.note === note && x.gate);
    v ??= this.voices.find((x) => !x.active);
    v ??= this.voices.filter((x) => !x.gate).sort((a, b) => a.age - b.age)[0];
    v ??= [...this.voices].sort((a, b) => a.age - b.age)[0];
    const sounding = !!v.active && v.stage !== 0;
    const ph = Uint32Array.from(v.ph);
    const s = Int32Array.from(v.s);
    v.note = note;
    v.vel = clamp(velocity, 1, 127);
    v.gate = 1;
    v.active = 1;
    v.stage = 1;
    v.age = ++this.clock;
    v.pitch16 = v.pitchCur = note * 16;
    v.fine = 0;
    if (!sounding) v.env = v.envOut = 0;
    this.def.noteOn(this.track, v);
    if (sounding) {
      v.ph.set(ph);
      for (let k = 0; k < 8; k++) if (k !== 2 && k !== 3 && (this.def.keep >> k) & 1) v.s[k] = s[k];
    }
  }

  noteOff(note: number): void {
    for (const v of this.voices) {
      if (v.active && v.gate && v.note === note) {
        v.gate = 0;
        if (v.stage !== 0) v.stage = 3;
      }
    }
  }

  allOff(): void {
    for (const v of this.voices) {
      if (v.active && v.gate) {
        v.gate = 0;
        v.stage = 3;
      }
    }
  }

  private envTick(v: EngVoice): number {
    const sus = this.env[2] << 17;
    switch (v.stage) {
      case 1:
        v.env += ENV_LIN[this.env[0]];
        if (v.env >= 1 << 24) { v.env = 1 << 24; v.stage = 2; }
        break;
      case 2:
        v.env += mulq16(sus - v.env, ENV_EXP[this.env[1]]);
        break;
      case 3:
        v.env -= mulq16(v.env, ENV_EXP[this.env[3]]);
        if (v.env < 1 << 12) { v.env = 0; v.stage = 0; v.active = 0; }
        break;
      default:
        v.env = 0;
    }
    return v.env >> 9;
  }

  private block(): void {
    const t = this.track;
    const e = this.def;
    this.buf.fill(0);
    e.block?.(t);
    for (let k = 0; k < this.voices.length; k++) {
      const v = this.voices[k];
      if (!v.active) continue;
      let env = this.envTick(v);
      if (e.amp) env = e.amp(t, v, env);
      if (!v.active) continue;
      const amp1 = mulq15(env, v.vel * 258);
      const amp0 = this.last[k];
      this.last[k] = amp1;
      if (!env && !amp0 && v.stage === 2) continue;
      const pitch16 = clamp(v.pitchCur, 0, 2047);
      const inc = pitchInc(pitch16);
      let cutoff = (env * this.fenv) >> 7;
      if (v.vel > 110) cutoff += (env * 24) >> 7;
      const m: Vmod = { pitch16, inc, fine: 0, amp0, amp1, envq15: env, cutoff, shape: 64 << 8 };
      e.render(t, v, this.buf, CTL, m);
    }
  }

  render(out: Float32Array, start: number, n: number): void {
    if (this.activeVoices === 0 && this.pos >= CTL) return;
    for (let i = 0; i < n; i++) {
      if (this.pos >= CTL) {
        if (this.activeVoices === 0) return;
        this.block();
        this.pos = 0;
      }
      out[start + i] += (this.buf[this.pos++] / 32768) * 0.6 * this.gain;
    }
  }
}
