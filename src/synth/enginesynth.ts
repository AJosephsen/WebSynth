// A polyphonic synth around one of the ported Felucca engines: voice allocation, ADSR, velocity and the ENV->FLT
// amount, after Felucca's voice.c (GPL-3.0-only). See NOTICE.
import { clamp, mulq15, mulq16, pitchInc } from "../engines/dsp";
import {
  CTL, EngineDef, EngVoice, P_ATAMT, P_ATDST, P_ATK, P_CHOR, P_DIST, P_DLY, P_E0, P_ED_FLT, P_ED_PIT, P_ED_SHP, P_FTYPE,
  P_LD_AMP, P_LD_FLT, P_LD_PIT, P_LD_SHP, P_LFADE, P_LPHASE, P_LPOL, P_LRATE, P_LSYNC, P_LTRIG, P_LWAVE, P_M1SRC, P_PAN, P_REL,
  P_REV, Track, Vmod,
} from "../engines/types";
import { ENV_EXP, ENV_LIN } from "../engines/felucca-tables";
import { lfoNoteOn, lfoTick, Modulator } from "../mod/mod";
import { ModSetup } from "../mod/setup";
import type { Instrument, Synth } from "./synth";

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
  private mod: Modulator;
  private bpm = 120;
  readonly mixMod = { pan: 0, dist: 0, chorus: 0, delay: 0, reverb: 0 };

  constructor(private def: EngineDef, inst: EngineInstrument, voices = 8) {
    const n = def.poly ? Math.min(voices, def.poly) : voices;
    this.voices = Array.from({ length: n }, () => new EngVoice());
    this.track.v = this.voices;
    this.last = new Int32Array(n);
    this.track.edit = def.edit;
    this.mod = new Modulator(this.track);
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
    p[P_ED_FLT] = inst.fenv;
  }

  setBpm(bpm: number): void { this.bpm = bpm; }

  setMix(m: { pan: number; dist: number; chorus: number; delay: number; reverb: number }): void {
    const p = this.track.p;
    p[P_PAN] = m.pan; p[P_DIST] = m.dist; p[P_CHOR] = m.chorus; p[P_DLY] = m.delay; p[P_REV] = m.reverb;
  }

  setMod(m: ModSetup | undefined): void {
    const p = this.track.p;
    const d = m ?? { rate: 60, wave: 0, phase: 0, fade: 0, sync: 0, trig: 0, pol: 0, ldPit: 0, ldFlt: 0, ldShp: 0, ldAmp: 0, edPit: 0, edShp: 0, slots: [], atDst: 0, atAmt: 0 };
    p[P_LRATE] = d.rate; p[P_LWAVE] = d.wave; p[P_LPHASE] = d.phase; p[P_LFADE] = d.fade; p[P_LSYNC] = d.sync;
    p[P_LTRIG] = d.trig; p[P_LPOL] = d.pol; p[P_LD_PIT] = d.ldPit; p[P_LD_FLT] = d.ldFlt; p[P_LD_SHP] = d.ldShp;
    p[P_LD_AMP] = d.ldAmp; p[P_ED_PIT] = d.edPit; p[P_ED_SHP] = d.edShp;
    for (let k = 0; k < 4; k++) {
      const s = d.slots[k];
      p[P_M1SRC + 3 * k] = s?.src ?? 0; p[P_M1SRC + 3 * k + 1] = s?.dst ?? 0; p[P_M1SRC + 3 * k + 2] = s?.amt ?? 0;
    }
    p[P_ATDST] = d.atDst; p[P_ATAMT] = d.atAmt;
  }

  midi(status: number, d1: number, d2: number): void { this.mod.midi(status, d1, d2); }

  stepDelay(note: number, vel: number, period: number): number { return this.mod.time(note, vel, period); }

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
    velocity = this.mod.note(note, clamp(velocity, 1, 127));
    v.note = note;
    v.vel = clamp(velocity, 1, 127);
    v.mvel = v.vel;
    v.mrnd = this.track.mRnd;
    this.track.mVi = this.voices.indexOf(v);
    lfoNoteOn(this.track);
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
    const p = t.p;
    const mod = this.mod;
    this.buf.fill(0);
    const on = mod.begin();
    this.mixMod.pan = p[P_PAN]; this.mixMod.dist = p[P_DIST]; this.mixMod.chorus = p[P_CHOR];
    this.mixMod.delay = p[P_DLY]; this.mixMod.reverb = p[P_REV];
    let lfo = mulq15(t.lfoVal, t.lfoFade);
    if (on && mod.w.ldep < 32767) lfo = mulq15(lfo, mod.w.ldep);
    lfoTick(t, this.bpm);
    e.block?.(t);
    for (let k = 0; k < this.voices.length; k++) {
      const v = this.voices[k];
      if (!v.active) continue;
      let env = this.envTick(v);
      if (e.amp) env = e.amp(t, v, env);
      if (!v.active) continue;
      let amp1 = mulq15(env, v.vel * 258);
      if (p[P_LD_AMP]) amp1 = mulq15(amp1, 32767 - mulq15(p[P_LPOL] ? lfo : (lfo + 32768) >> 1, p[P_LD_AMP] * 258));
      const amp0 = this.last[k];
      this.last[k] = amp1;
      v.envOut = amp1;
      if (!env && !amp0 && v.stage === 2 && !e.sampled) continue;
      const pitch16 = clamp(v.pitchCur + ((lfo * p[P_LD_PIT] * 3) >> 15) + ((env * p[P_ED_PIT] * 3) >> 15), 0, 2047);
      const inc = pitchInc(pitch16);
      let cutoff = ((lfo * p[P_LD_FLT]) >> 7) + ((env * p[P_ED_FLT]) >> 7);
      if (v.vel > 110) cutoff += (env * 24) >> 7;
      const shape = (64 << 8) + ((lfo * p[P_LD_SHP]) >> 7) + ((env * p[P_ED_SHP]) >> 7);
      const m: Vmod = { pitch16, inc, fine: 0, amp0, amp1, envq15: env, cutoff, shape };
      if (on) {
        mod.voice(v, m, 0);
        this.last[k] = v.envOut;
      }
      e.render(t, v, this.buf, CTL, m);
    }
    if (on) mod.end();
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
