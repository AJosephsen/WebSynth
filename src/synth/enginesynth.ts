// A polyphonic synth around one of the ported Felucca engines: voice allocation, ADSR, velocity and the ENV->FLT
// amount, after Felucca's voice.c (GPL-3.0-only). See NOTICE.
import { clamp, mulq15, mulq16, pitchInc } from "../engines/dsp";
import {
  CTL, EngineDef, EngVoice, P_ATAMT, P_ATDST, P_ATK, P_CHOR, P_DIST, P_DLY, P_E0, P_ED_FLT, P_ED_PIT, P_ED_SHP, P_FTYPE,
  P_LD_AMP, P_LD_FLT, P_LD_PIT, P_LD_SHP, P_LFADE, P_LPHASE, P_LPOL, P_LRATE, P_LSYNC, P_LTRIG, P_LWAVE, P_M1SRC, P_PAN, P_REL,
  P_REV, P_ALLOC, P_DETUNE, P_GLIDE, P_GLMODE, P_PRIO, P_SPRD, P_VOICE, P_DEC, P_SUS, Track, Vmod,
} from "../engines/types";
import { ENV_EXP, ENV_LIN } from "../engines/felucca-tables";
import { lfoTick, Modulator } from "../mod/mod";
import { VoiceLayer } from "./voicelayer";
import { ModSetup } from "../mod/setup";
import type { ParamStore } from "../seq/motion";
import type { Instrument, Synth } from "./synth";

type EngineInstrument = Extract<Instrument, { kind: "engine" }>;

export class EnginePoly implements Synth {
  gain = 1;
  private track = new Track();
  private voices: EngVoice[];
  private fenv = 0;
  private layer: VoiceLayer;
  private buf = new Int32Array(CTL);
  private sbuf = new Int32Array(CTL); // SPREAD: the left voices
  spreadActive = false;
  /** Values the sequencer's locks and automation hold over the instrument's own. */
  private readonly held = new Map<number, number>();
  readonly paramStore: ParamStore = {
    read: (id) => this.track.p[id],
    write: (id, v) => { this.held.set(id, v); this.track.p[id] = v; },
    release: (id, v) => { this.held.delete(id); this.track.p[id] = v; },
  };
  private reapply(): void { for (const [id, v] of this.held) this.track.p[id] = v; }
  get voiceMode(): number { return this.track.p[P_VOICE]; }
  get spreadAmount(): number { return this.track.p[P_SPRD]; }
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
    this.layer = new VoiceLayer(this.track, this.voices, def, (note, vel) => this.mod.note(note, clamp(vel, 1, 127)));
    this.setInstrument(inst);
  }

  setInstrument(inst: EngineInstrument): void {
    const p = this.track.p;
    inst.params.forEach((v, k) => (p[P_E0 + k] = v));
    p[P_ATK] = inst.env[0];
    p[P_DEC] = inst.env[1];
    p[P_SUS] = inst.env[2];
    p[P_REL] = inst.env[3];
    p[P_FTYPE] = inst.ftype ?? 0;
    this.fenv = inst.fenv;
    p[P_ED_FLT] = inst.fenv;
    const vp = inst.vp;
    p[P_VOICE] = vp?.voice ?? (inst.mono ? 1 : 0);
    p[P_GLIDE] = vp?.glide ?? 0;
    p[P_GLMODE] = vp?.glmode ?? 0;
    p[P_PRIO] = vp?.prio ?? 0;
    p[P_ALLOC] = vp?.alloc ?? 0;
    p[P_DETUNE] = vp?.detune ?? 40;
    p[P_SPRD] = vp?.spread ?? 0;
    this.reapply();
  }

  setBpm(bpm: number): void { this.bpm = bpm; }

  setMix(m: { pan: number; dist: number; chorus: number; delay: number; reverb: number }): void {
    const p = this.track.p;
    p[P_PAN] = m.pan; p[P_DIST] = m.dist; p[P_CHOR] = m.chorus; p[P_DLY] = m.delay; p[P_REV] = m.reverb;
    this.reapply();
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

  noteOn(note: number, velocity = 100): void { this.layer.noteOn(note, velocity); }

  noteOff(note: number): void { this.layer.noteOff(note); }

  /** The next legato note glides (a step's slide). */
  setSlide(on: boolean): void { this.layer.slideGlide = on ? 1 : 0; }

  allOff(): void { this.layer.allOff(); }

  private envTick(v: EngVoice): number {
    const p = this.track.p;
    const sus = p[P_SUS] << 17;
    switch (v.stage) {
      case 1:
        v.env += ENV_LIN[p[P_ATK] & 127];
        if (v.env >= 1 << 24) { v.env = 1 << 24; v.stage = 2; }
        break;
      case 2:
        v.env += mulq16(sus - v.env, ENV_EXP[p[P_DEC] & 127]);
        break;
      case 3:
        v.env -= mulq16(v.env, ENV_EXP[p[P_REL] & 127]);
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
    this.spreadActive = p[P_SPRD] > 0 && (p[P_VOICE] === 0 || p[P_VOICE] === 3);
    if (this.spreadActive) this.sbuf.fill(0);
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
      if (v.pitchCur !== v.pitch16) { // glide
        const d = v.pitch16 - v.pitchCur;
        let st = v.gstep ? v.gstep : ENV_LIN[(p[P_GLIDE] ? p[P_GLIDE] : 40) & 127] >> 14;
        if (st < 1) st = 1;
        v.pitchCur += d > 0 ? (d < st ? d : st) : -d < st ? d : -st;
      }
      const pitch16 = clamp(v.pitchCur + ((lfo * p[P_LD_PIT] * 3) >> 15) + ((env * p[P_ED_PIT] * 3) >> 15), 0, 2047);
      let inc = pitchInc(pitch16);
      if (v.fine) inc = (inc + Math.imul(inc >>> 12, v.fine)) >>> 0;
      let cutoff = ((lfo * p[P_LD_FLT]) >> 7) + ((env * p[P_ED_FLT]) >> 7);
      if (v.vel > 110) cutoff += (env * 24) >> 7;
      const shape = (64 << 8) + ((lfo * p[P_LD_SHP]) >> 7) + ((env * p[P_ED_SHP]) >> 7);
      const m: Vmod = { pitch16, inc, fine: v.fine, amp0, amp1, envq15: env, cutoff, shape };
      if (on) {
        mod.voice(v, m, v.fine);
        this.last[k] = v.envOut;
      }
      e.render(t, v, this.spreadActive && v.side === 0 ? this.sbuf : this.buf, CTL, m);
    }
    if (this.spreadActive) for (let i = 0; i < CTL; i++) this.buf[i] += this.sbuf[i]; // buf: every voice; sbuf: the left ones
    if (on) mod.end();
  }

  render(out: Float32Array, start: number, n: number, side?: Float32Array): void {
    if (this.activeVoices === 0 && this.pos >= CTL) return;
    const k = (0.6 * this.gain) / 32768;
    for (let i = 0; i < n; i++) {
      if (this.pos >= CTL) {
        if (this.activeVoices === 0) return;
        this.block();
        this.pos = 0;
      }
      out[start + i] += this.buf[this.pos] * k;
      if (side && this.spreadActive) side[start + i] += (2 * this.sbuf[this.pos] - this.buf[this.pos]) * k;
      this.pos++;
    }
  }
}
