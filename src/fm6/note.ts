// Port of fm6_core.c note handling (msfa note init/compute) and a single-voice wrapper. See NOTICE.
import { FP } from "./patch";
import { CTL } from "./tables";
import { Env, Lfo, PitchEnv, scaleout } from "./env";
import { Op, render } from "./core";
import { freq, mant } from "./math";
import { ALG } from "./algorithms";
import { AMSENS, AMS_C0, AMS_K, COARSE, DETUNE, EXPSCALE, FINE, PMS, VELDATA } from "./data";

const LOGF0 = 50857777; // log2 of MIDI note 0's frequency, Q24
const THRESH = 1120;

/** Bit k set: operator k (the sixth first) is a carrier of algorithm a (0..31). */
function carriers(a: number): number {
  let c = 0;
  for (let k = 0; k < 6; k++) c |= (ALG[a & 31][k] & 3 ? 0 : 1) << k;
  return c;
}

function scaleVel(vel: number, sens: number): number {
  const v = VELDATA[(vel < 0 ? 0 : vel > 127 ? 127 : vel) >> 1] - 239;
  return ((sens * v + 7) >> 3) * 16;
}
function scaleRate(note: number, sens: number): number {
  let x = Math.trunc(note / 3) - 7;
  x = x < 0 ? 0 : x > 31 ? 31 : x;
  return (sens * x) >> 3;
}
function scaleCurve(group: number, depth: number, curve: number): number {
  const s = curve === 0 || curve === 3
    ? (group * depth * 329) >> 12
    : (EXPSCALE[group > 32 ? 32 : group] * depth * 329) >> 15;
  return curve < 2 ? -s : s;
}
function scaleLevel(note: number, p: Uint8Array, o: number): number {
  const off = note - p[o + FP.BP] - 17;
  return off >= 0
    ? scaleCurve(Math.trunc((off + 1) / 3), p[o + FP.RD], p[o + FP.RC])
    : scaleCurve(Math.trunc(-(off - 1) / 3), p[o + FP.LD], p[o + FP.LC]);
}
function oscBase(p: Uint8Array, o: number, note: number): number {
  const det = p[o + FP.DET];
  if (!p[o + FP.MODE]) {
    const lf = DETUNE[note] * (det - 7) + COARSE[p[o + FP.FC] & 31];
    return p[o + FP.FF] ? lf + FINE[p[o + FP.FF] % 100] : lf;
  }
  return ((4458616 * ((p[o + FP.FC] & 3) * 100 + (p[o + FP.FF] % 100))) >> 3) + (det > 7 ? 13457 * (det - 7) : 0);
}

/** Log2 frequency (Q24) of a pitch in 1/16 semitone plus a fine factor. */
export function logFreq(pitch16: number, fine = 0): number {
  return LOGF0 + Math.floor((pitch16 * Math.trunc((1 << 24) / 12)) / 16) + fine * 5909;
}

/** One sounding note of a patch (msfa's note). */
export class Note {
  env = Array.from({ length: 6 }, () => new Env());
  op: Op[] = Array.from({ length: 6 }, () => ({ levelIn: 0, gainOut: 0, freq: 0, phase: 0 }));
  base = new Int32Array(6);
  fb = new Int32Array(2);
  penv = new PitchEnv();
  fixed = 0;
  live = false;
  down = false;
  dc = 0;

  init(p: Uint8Array, note: number, vel: number, fresh: boolean): void {
    note = note < 0 ? 0 : note > 127 ? 127 : note;
    if (fresh) {
      for (const o of this.op) { o.phase = 0; o.gainOut = 0; }
      this.fb.fill(0);
      this.dc = 0;
    }
    this.fixed = 0;
    for (let k = 0; k < 6; k++) {
      const o = k * FP.OP;
      let ol = scaleout(p[o + FP.OL]) + scaleLevel(note, p, o);
      ol = (ol > 127 ? 127 : ol) << 5;
      ol += scaleVel(vel, p[o + FP.KVS]);
      this.env[k].init(p, o, ol < 0 ? 0 : ol, scaleRate(note, p[o + FP.RS]));
      this.base[k] = oscBase(p, o, note);
      this.fixed |= (p[o + FP.MODE] & 1) << k;
    }
    this.penv.init(p);
    this.live = this.down = true;
  }

  key(p: Uint8Array, down: boolean): void {
    for (let k = 0; k < 6; k++) this.env[k].key(p, k * FP.OP, down);
    this.penv.key(p, down);
    this.down = down;
  }

  /** Renders one block (Q24) into out. Returns false when silent (out untouched). */
  compute(p: Uint8Array, out: Int32Array, lfoVal: number, lfoDelay: number, logfreq: number, alg: number, fb: number): boolean {
    const pmd = ((((p[FP.LPMD] % 100) * 165) >> 6) * lfoDelay); // Q32
    const senslfo = PMS[p[FP.LPMS] & 7] * (lfoVal - (1 << 23));
    let pmod = Number((BigInt(pmd) * BigInt(senslfo)) >> 39n);
    pmod = pmod < 0 ? -pmod : pmod;
    const pitchMod = this.penv.get(p) + (senslfo < 0 ? -pmod : pmod);
    const amd = ((p[FP.LAMD] % 100) * 165) >> 6;
    let amod = Math.floor((amd * lfoDelay) / 256); // Q24
    amod = Math.floor((amod * ((1 << 24) - lfoVal)) / 2 ** 24);
    for (let k = 0; k < 6; k++) {
      const o = k * FP.OP;
      let level = this.env[k].get(p, o);
      const ams = AMSENS[p[o + FP.AMS] & 3];
      this.op[k].freq = freq((this.fixed >> k) & 1 ? this.base[k] : logfreq + this.base[k] + pitchMod);
      if (ams) {
        const sensamp = Math.floor((amod * ams) / 2 ** 24);
        const lg = AMS_C0 + Math.floor((sensamp * AMS_K) / 1024);
        const pt = Math.floor(mant(lg) / 2 ** (30 - (lg >> 24)));
        level -= Number((BigInt(level) * (BigInt(pt) << 4n)) >> 28n);
      }
      this.op[k].levelIn = level < 0 ? 0 : level > 17 << 24 ? 17 << 24 : level;
    }
    return render(out, this.op, alg, this.fb, fb ? 8 - fb : 16);
  }

  /** Every carrier is silent for good: the note can be dropped. */
  done(p: Uint8Array, alg: number): boolean {
    const car = carriers(alg);
    for (let k = 0; k < 6; k++) {
      const e = this.env[k];
      if (!((car >> k) & 1)) continue;
      if (this.op[k].gainOut >= THRESH) return false;
      if (e.ix < 3) return false;
      if (e.ix === 3 && !e.down && e.rising) return false;
      if (e.ix === 3 && e.down) {
        const a = ((scaleout(p[k * FP.OP + FP.L1 + 3]) >> 1) << 6) + e.outlevel - 4256;
        if ((a < 16 ? 16 : a) << 16 > e.level) return false;
      }
    }
    return true;
  }
}

/** A monophonic DX7-style voice: one patch, one note at a time. Output is float, roughly -1..1. */
export class Fm6Voice {
  private note = new Note();
  private lfo = new Lfo();
  private bus = new Int32Array(CTL);
  private pos = CTL; // next unread sample of the current block
  private blockOut = new Float32Array(CTL);
  private midi = 60;
  patch: Uint8Array;

  constructor(patch: Uint8Array) {
    this.patch = patch;
    this.lfo.reset(patch);
  }

  setPatch(patch: Uint8Array): void {
    this.patch = patch;
    this.lfo.reset(patch);
  }

  noteOn(midiNote: number, velocity = 100): void {
    this.midi = midiNote;
    this.note.init(this.patch, midiNote + this.patch[FP.TRNSP] - 24, velocity, !this.note.live);
    this.lfo.key();
  }

  noteOff(): void {
    if (this.note.live) this.note.key(this.patch, false);
  }

  get active(): boolean {
    return this.note.live;
  }

  private block(): void {
    const n = this.note;
    this.blockOut.fill(0);
    if (!n.live) return;
    const p = this.patch;
    const alg = p[FP.ALG];
    const lf = logFreq(this.midi * 16 + (p[FP.TRNSP] - 24) * 16);
    const ok = n.compute(p, this.bus, this.lfo.sample(), this.lfo.delay(), lf, alg, p[FP.FB]);
    if (ok) {
      for (let i = 0; i < CTL; i++) {
        const x = this.bus[i] - n.dc;
        n.dc += x >> 10; // one-pole high-pass: FM puts sidebands at 0 Hz
        this.blockOut[i] = (x / 2 ** 24) * 0.25;
      }
    }
    if (n.done(p, alg)) n.live = false;
  }

  next(): number {
    if (this.pos >= CTL) { this.block(); this.pos = 0; }
    return this.blockOut[this.pos++];
  }
}
