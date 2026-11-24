// Voice allocation of one part, a port of Felucca's voice.c (GPL-3.0-only): POLY (rotate or reuse allocation, stealing),
// MONO / LEGATO / UNISON with LAST / LOW / HIGH priority, glide (RATE or TIME) and the unison detune. See NOTICE.
// (Felucca shares eight voices among its four parts; here each part has its own, so there is no cross-part stealing.)
import { KeyMapParams, microActive, scalePitch } from "./keymap";
import { EngVoice, P_ALLOC, P_DETUNE, P_GLIDE, P_GLMODE, P_LPHASE, P_LTRIG, P_MUTE, P_PRIO, P_VOICE, Track } from "../engines/types";

export const V_POLY = 0, V_MONO = 1, V_LEGATO = 2, V_UNISON = 3;
const NVOICE = 8;

export interface VoiceEngine {
  /** The voices the engine can sound at once (0: all). */
  poly?: number;
  sampled?: boolean;
  /** The engine's state slots a retrigger keeps (engine_t.keep). */
  keep: number;
  noteOn(t: Track, v: EngVoice): void;
}

let unisonSeed = 0x1234567;

export class VoiceLayer {
  nmono = 0;
  readonly monoStack = new Uint8Array(8);
  monoNote = 0;
  rr = 0;
  slideGlide = 0;
  /** The part's scale when it is microtonal (QNT on): a note is a degree of it and its pitch comes from the table (voice_scale_pitch). */
  scale: KeyMapParams | null = null;
  private noteTarget(note: number): number { return this.scale && microActive(this.scale) ? scalePitch(this.scale, note).pitch16 : note * 16; }
  private setPitch(v: EngVoice, note: number): void {
    if (this.scale && microActive(this.scale)) { const s = scalePitch(this.scale, note); v.pitch16 = s.pitch16; v.scaleFine = s.fine; } else { v.pitch16 = note * 16; v.scaleFine = 0; }
  }
  spAlt = 0;
  private vage = 0;

  /**
   * @param t the part (its p[] holds the voice parameters, and the LFO state)
   * @param voices its voices (at most 8)
   * @param noteHook the matrix's note-on (returns the velocity the note plays at)
   */
  constructor(private readonly t: Track, private readonly voices: EngVoice[], private readonly e: VoiceEngine, private readonly noteHook: (note: number, vel: number) => number) {}

  private get nvoice(): number { const c = this.e.poly ?? 0; return c && c < NVOICE ? c : NVOICE; }
  private get mode(): number { return this.t.p[P_VOICE]; }

  private busy(): number {
    let n = 0;
    for (const v of this.voices) n += v.active && v.stage !== 4 ? 1 : 0;
    return n;
  }
  private lowestHeld(): number {
    let low = NVOICE;
    this.voices.forEach((v, i) => { if (v.active && v.gate && (low === NVOICE || v.note < this.voices[low].note)) low = i; });
    return low;
  }
  private victim(soft: boolean): number {
    if (soft) return NVOICE;
    const mode = this.mode;
    const low = mode === V_POLY ? this.lowestHeld() : NVOICE;
    let best = NVOICE, cat = 4;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (!v.active || v.stage === 4) continue;
      let c: number;
      if (!v.gate) c = 1;
      else if (mode !== V_POLY && i > 0) c = 2;
      else if (mode === V_POLY && i !== low) c = 3;
      else continue;
      if (c < cat || (c === cat && v.age < this.voices[best].age)) { cat = c; best = i; }
    }
    return best;
  }
  private kill(v: EngVoice): void { v.gate = 0; v.stage = 4; }
  private room(soft: boolean): boolean {
    if (this.busy() < NVOICE) return true;
    const k = this.victim(soft);
    if (k === NVOICE) return !soft;
    this.kill(this.voices[k]);
    return true;
  }
  private reuse(v: EngVoice): EngVoice {
    if (v.stage === 4) this.room(false);
    return v;
  }

  private alloc(note: number): EngVoice {
    const np = Math.min(this.nvoice, this.voices.length);
    const p = this.t.p;
    let best = np, low = np, nfree = 0, bd = 0x7fffffff;
    for (let i = 0; i < np; i++) {
      if (this.voices[i].active && this.voices[i].note === note) return this.reuse(this.voices[i]);
      nfree += this.voices[i].active ? 0 : 1;
    }
    if (nfree && this.busy() >= NVOICE) {
      const k = this.victim(false);
      if (k < np) return this.voices[k];
      if (k < NVOICE) this.kill(this.voices[k]);
    }
    if (p[P_ALLOC] || p[P_GLIDE]) {
      for (let i = 0; i < np; i++) {
        const v = this.voices[i];
        let d = v.pitchCur - this.noteTarget(note);
        if (v.active) continue;
        d = d < 0 ? -d : d;
        if (!v.pitchCur) d = 0x7ffffff0;
        if (d < bd) { bd = d; best = i; }
      }
    } else {
      for (let i = 0; i < np && best === np; i++) {
        const k = (this.rr + i) % np;
        if (!this.voices[k].active) best = k;
      }
      this.rr = ((best === np ? this.rr : best) + 1) % np;
    }
    if (best < np) return this.voices[best];
    for (let i = 0; i < np; i++) if (this.voices[i].gate && (low === np || this.voices[i].note < this.voices[low].note)) low = i;
    for (let i = 0; i < np; i++) if (!this.voices[i].gate && this.voices[i].stage !== 4 && (best === np || this.voices[i].age < this.voices[best].age)) best = i;
    if (best === np) for (let i = 0; i < np; i++) if (i !== low && (best === np || this.voices[i].age < this.voices[best].age)) best = i;
    return this.reuse(this.voices[best === np ? 0 : best]);
  }

  private glideSet(v: EngVoice, glide: boolean): void {
    if (!glide || !v.pitchCur) { v.pitchCur = v.pitch16; v.gstep = 0; return; }
    const p = this.t.p;
    if (p[P_GLMODE]) {
      let d = v.pitch16 - v.pitchCur;
      const ticks = 1 + Math.trunc((p[P_GLIDE] * p[P_GLIDE]) / 8);
      d = d < 0 ? -d : d;
      const q = Math.trunc(d / ticks);
      v.gstep = q > 0 ? q : 1;
    } else v.gstep = 0;
  }

  private start(v: EngVoice, note: number, vel: number, glide: boolean): void {
    const sounding = v.active && v.stage !== 0;
    const ph0 = v.ph[0], ph1 = v.ph[1], ph2 = v.ph[2];
    const s0 = v.s[0], s1 = v.s[1], s4 = v.s[4], s5 = v.s[5], s6 = v.s[6], s7 = v.s[7];
    const keep = this.e.keep;
    v.note = note;
    v.vel = vel;
    v.gate = 1;
    v.active = 1;
    v.stage = 1;
    v.age = ++this.vage;
    this.setPitch(v, note);
    v.mvel = this.t.mVel;
    v.mrnd = this.t.mRnd;
    this.t.mVi = this.voices.indexOf(v);
    this.glideSet(v, glide);
    if (!sounding) {
      v.env = 0;
      v.envOut = 0;
      v.side = this.spAlt;
      this.spAlt ^= 1;
    }
    this.e.noteOn(this.t, v);
    if (sounding && !this.e.sampled) {
      v.ph[0] = ph0; v.ph[1] = ph1; v.ph[2] = ph2;
      if (keep & 0x01) v.s[0] = s0;
      if (keep & 0x02) v.s[1] = s1;
      if (keep & 0x10) v.s[4] = s4;
      if (keep & 0x20) v.s[5] = s5;
      if (keep & 0x40) v.s[6] = s6;
      if (keep & 0x80) v.s[7] = s7;
    }
  }

  private monoPlay(note: number, vel: number, retrig: boolean, glide: boolean): void {
    const p = this.t.p;
    const mode = p[P_VOICE], nv = mode === V_UNISON ? Math.min(this.nvoice, this.voices.length) : 1;
    for (let i = 0; i < nv; i++) {
      const v = this.voices[i];
      let k = 2 * i - (nv - 1);
      if (nv > 1 && nv < NVOICE) k = Math.trunc((k * (NVOICE - 1)) / (nv - 1));
      v.fine = nv > 1 ? Math.trunc((k * p[P_DETUNE] * 56) / 889) : 0;
      if (retrig || !v.active || !v.gate) {
        if ((!v.active || v.stage === 4) && !this.room(i > 0)) continue;
        this.start(v, note, nv >= NVOICE ? Math.floor((vel * 36) / 100) : nv > 1 ? Math.floor(vel / 2) : vel, glide);
        v.side = i & 1;
        if (nv > 1 && i && !this.e.sampled) {
          unisonSeed = (Math.imul(unisonSeed, 1664525) + 1013904223) >>> 0;
          v.ph[0] = (v.ph[0] + unisonSeed) >>> 0;
        }
      } else {
        v.note = note;
        this.setPitch(v, note);
        v.mvel = this.t.mVel;
        v.mrnd = this.t.mRnd;
        if (vel > v.vel && nv === 1) v.vel = vel;
        this.glideSet(v, glide);
      }
    }
    this.monoNote = note;
  }

  private monoPick(): number {
    if (!this.nmono) return 0;
    const prio = this.t.p[P_PRIO];
    let n = this.monoStack[this.nmono - 1];
    for (let i = 0; i < this.nmono; i++) {
      if (prio === 1 && this.monoStack[i] < n) n = this.monoStack[i];
      if (prio === 2 && this.monoStack[i] > n) n = this.monoStack[i];
    }
    return n;
  }
  private monoRemove(note: number): void {
    let k = 0;
    for (let j = 0; j < this.nmono; j++) if (this.monoStack[j] !== note) this.monoStack[k++] = this.monoStack[j];
    this.nmono = k;
  }

  noteOn(note: number, vel: number): void {
    const t = this.t, p = t.p, mode = this.mode;
    if (p[P_MUTE]) return;
    vel = this.noteHook(note, vel);
    let any = 0;
    for (const v of this.voices) any |= v.gate;
    if (!any) {
      if (!p[P_LTRIG]) t.lfoPh = (p[P_LPHASE] << 25) >>> 0;
      t.lfoFade = 0;
    }
    if (mode === V_POLY) {
      const v = this.alloc(note);
      this.nmono = 0;
      this.monoNote = 0;
      v.fine = 0;
      this.start(v, note, vel, p[P_GLIDE] !== 0);
      return;
    }
    const sounding = !!(this.monoNote && this.voices[0].active && this.voices[0].gate);
    this.monoRemove(note);
    if (this.nmono >= 8) this.monoRemove(this.monoStack[0]);
    this.monoStack[this.nmono++] = note;
    const want = this.monoPick();
    if (sounding && want === this.monoNote) return;
    if (mode === V_MONO) this.monoPlay(want, vel, true, p[P_GLIDE] !== 0 || !!this.slideGlide);
    else this.monoPlay(want, vel, !sounding, sounding && (p[P_GLIDE] !== 0 || !!this.slideGlide));
  }

  noteOff(note: number): void {
    const p = this.t.p, mode = this.mode;
    this.monoRemove(note);
    if (mode !== V_POLY) {
      const nv = mode === V_UNISON ? Math.min(this.nvoice, this.voices.length) : 1;
      if (this.monoNote === note) {
        const next = this.monoPick();
        if (next) this.monoPlay(next, this.voices[0].vel, false, p[P_GLIDE] !== 0);
        else {
          for (let i = 0; i < nv; i++) if (this.voices[i].gate) { this.voices[i].gate = 0; this.voices[i].stage = 3; }
          this.monoNote = 0;
        }
      }
    }
    for (const v of this.voices) if (v.note === note && v.gate) { v.gate = 0; v.stage = 3; }
  }

  allOff(): void {
    for (const v of this.voices) { v.gate = 0; v.stage = v.active ? 3 : 0; }
    this.nmono = 0;
    this.monoNote = 0;
  }
}
