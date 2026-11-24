// Fixed-point helpers shared by the ports of Melodee's drum kits (drum_808.c, drum_lanes.c; GPL-3.0-only, Kerem Kilic): the
// dithered voice cut of dsp.c, the 1/16-semitone power of two, the trapezoidal state-variable filters, the decay envelopes
// and the exact 64-bit products. C int32 arithmetic uses Math.imul / >> / | 0, uint32 uses >>> 0. See NOTICE.
import { mulsh } from "../engines/i64";
import { pitchInc, softclip } from "../engines/dsp";
import { CTL } from "../engines/types";

export const CTL_LOG2 = 5;
export const VOICE_FS = 24000;

/** (a * b) >> sh of the 64-bit product, a and b int32 (the result may exceed int32: the caller truncates as C does). */
export function mulShr(a: number, b: number, sh: number): number {
  const p = a * b;
  if (p < 4503599627370496 && p > -4503599627370496) return Math.floor(p / 2 ** sh);
  if (sh >= 16) return mulsh(a, b, sh);
  return a * (b >> 16) * 2 ** (16 - sh) + Math.floor((a * (b & 0xffff)) / 2 ** sh);
}

/** (a * b + 2^29) >> 30 truncated to int32: one Chamberlin step. */
export function mulR30(a: number, b: number): number {
  const p = a * b + 536870912;
  if (p < 4503599627370496 && p > -4503599627370496) return Math.floor(p / 1073741824) | 0;
  const hi = a * (b >> 16);
  const lo = a * (b & 0xffff);
  const hq = Math.floor(hi / 16384);
  const hr = hi - hq * 16384;
  return (hq + Math.floor((hr * 65536 + lo + 536870912) / 1073741824)) | 0;
}

/** TPDF dither table of dsp.c (dither_block, once per block before any engine renders). */
export class Dither {
  readonly t = new Int16Array(32);
  r = 0x2545f491;
  block(): void {
    let r = this.r;
    for (let k = 0; k < 32; k++) {
      r = (Math.imul(r, 1664525) + 1013904223) >>> 0;
      this.t[k] = (r >>> 17) - ((r >>> 2) & 32767);
    }
    this.r = r;
  }
}

/** voice_amp: the sample s at the amplitude ramp's sample i, to the voice level, with one dithered cut. */
export function voiceAmpD(s: number, amp0: number, amp1: number, i: number, dith: Int16Array): number {
  const x = Math.imul(amp1 - amp0, i);
  const a = amp0 + ((x + ((x >> 31) & (CTL - 1))) >> CTL_LOG2);
  const pr = Math.imul(s, Math.imul(a, VOICE_FS) >> 15);
  return ((pr + (pr !== 0 ? dith[(i + amp1) & 31] + 16384 : 0)) | 0) >> 15;
}

/** 2^(d16 / 192), Q16 (pow2_q16). */
export function pow2q16(d16: number): number {
  const u = (d16 + 3072) >>> 0;
  const oct = Math.floor(u / 192);
  const r = Math.floor(pitchInc(1600 + (u % 192)) / (pitchInc(1600) >>> 16));
  return oct >= 16 ? (r << (oct - 16)) >>> 0 : r >>> (16 - oct);
}

/** The soft knee of dsp.c. */
export function softKneeI(y: number, k: number): number {
  let a = y < 0 ? -y : y;
  if (a <= k) return y;
  a = k + (softclip((a - k) * 2) >> 1);
  return y < 0 ? -a : a;
}

/** Trapezoidal SVF coefficients (Q13) and damping, as drf_t. */
export interface Drf { a1: number; a2: number; a3: number; k: number }
export const drf = (a1: number, a2: number, a3: number, k: number): Drf => ({ a1, a2, a3, k });
export const int16 = (x: number): number => (x << 16) >> 16;

/** Band-pass (gain Q at fc); the two states live in s[o], s[o + 1]. */
export function drfBp(c: Drf, x: number, s: Int32Array, o: number): number {
  const v3 = (x - s[o + 1]) | 0;
  const v1 = (Math.imul(c.a1, s[o]) + Math.imul(c.a2, v3)) >> 13;
  const v2 = (s[o + 1] + ((Math.imul(c.a2, s[o]) + Math.imul(c.a3, v3)) >> 13)) | 0;
  s[o] = 2 * v1 - s[o];
  s[o + 1] = 2 * v2 - s[o + 1];
  return v1;
}
export function drfHp(c: Drf, x: number, s: Int32Array, o: number): number {
  const v3 = (x - s[o + 1]) | 0;
  const v1 = (Math.imul(c.a1, s[o]) + Math.imul(c.a2, v3)) >> 13;
  const v2 = (s[o + 1] + ((Math.imul(c.a2, s[o]) + Math.imul(c.a3, v3)) >> 13)) | 0;
  s[o] = 2 * v1 - s[o];
  s[o + 1] = 2 * v2 - s[o + 1];
  return (x - (Math.imul(c.k, v1) >> 13) - v2) | 0;
}

/** 2 sin(pi fc / FS), Q30, fc in 1/16 Hz (dr_freq). */
export function drFreq(hz16: number): number {
  const x = Math.imul(hz16, 4781);
  const x3 = mulShr(mulShr(x, x, 30) | 0, x, 30) | 0;
  return (2 * x - Math.trunc(x3 / 3)) | 0;
}
export const drF = (hz: number): number => drFreq(Math.trunc(hz * 16) >>> 0);

/** damping of a resonator ringing with time constant tau samples (dr_damp). */
export function drDamp(f: number, tau: number): number {
  let p = (f >>> 0) * (tau ? tau >>> 0 : 1);
  let e = 0;
  if (!p) return 3 << 29;
  while (p >= 2147483648) { p = Math.floor(p / 2); e++; }
  while (p < 1073741824) { p *= 2; e--; }
  const r = Math.floor(4294967295 / Math.floor(p / 32768));
  if (e >= 14) return (r >>> (e - 14)) | 0;
  return r >= (1610612736 >>> (14 - e)) ? 3 << 29 : (r << (14 - e)) | 0;
}

/** one-pole coefficient, Q14 (dr_lp1) */
export function drLp1(hz: number): number {
  const w = Math.floor(Math.imul(hz, 2390) >>> 0) >>> 10;
  return Math.trunc(Math.imul(w, 16384) / (16384 + Math.trunc(w / 2)));
}

export const drPow2 = (pitch: number): number => pow2q16(pitch);
/** base * 2^(v / oct) */
export const drExp = (base: number, v: number, oct: number): number => Math.floor((base * drPow2(Math.trunc((v * 192) / oct))) / 65536) >>> 0;
export const drTuned = (f: number, tune: number): number => mulShr(f, drPow2(tune), 16) | 0;

/** the level of a hit at velocity vel (Q15): 1 at 127, down to 1 - acc / 127 at 0 */
export function dr8Level(vel: number, acc: number): number {
  const a = acc < 0 ? 0 : acc > 127 ? 127 : acc;
  return 32767 - Math.trunc(Math.imul(Math.imul(a, 127 - (vel > 127 ? 127 : vel)), 32767) / (127 * 127));
}

export const drMs = (ms: number): number => Math.floor((ms * 441) / 10);
export const drTau = (ms: number): number => Math.floor((drMs(ms) * 10) / 46);

/** exp(-CTL / tau), Q16 (dr_blk) */
export function drBlk(tau: number): number {
  if (tau < 2 * CTL) tau = 2 * CTL;
  const x = Math.floor((CTL * 65536) / tau);
  const x2 = (x * x) >>> 16;
  return (65536 - x + (x2 >>> 1) - Math.floor(((x2 * x) >>> 16) / 6)) | 0;
}

/** A decay: value Q24 (e) and the factor per block, Q16 (k). */
export class Dre {
  e = 0;
  k = 0;
  hit(level: number, tau: number): void {
    if (level > this.e) this.e = level;
    this.k = drBlk(tau);
  }
}
export const DRE_LOW = 1 << 11;
export const DR_QUIET = 8;
export const DR_PEND = 200;
export const DR_P1 = 44;
export const DR_LIFE = drMs(6000);
export const DR_DUTY = 2060725309;
/** dre_next: the envelope's step over the block; its start in DRS[0]. */
export const DRS = new Int32Array(1);
export function dreNext(e: Dre): number {
  const a = e.e;
  e.e = Math.floor((a * e.k) / 65536) | 0;
  DRS[0] = a;
  return (e.e - a) | 0;
}
/** DRE_AT: the envelope's value at sample i, Q15 */
export const dreAt = (e0: number, de: number, i: number): number => (e0 + (Math.imul(de, i) >> CTL_LOG2)) >> 9;

/** one Chamberlin state-variable step, band-pass out; f, q Q30, rounded (dr_res) */
export function drRes(lp: Int32Array, i: number, bp: Int32Array, j: number, f: number, q: number, x: number): number {
  const b = bp[j];
  const l = (lp[i] + mulR30(f, b)) | 0;
  const h = (x - l - mulR30(q, b)) | 0;
  lp[i] = l;
  bp[j] = (b + mulR30(f, h)) | 0;
  return bp[j];
}

/** The trigger pulse (1 ms at the trigger level) through the BD's pulse shaper (dr_pulse); px is in st[o]. */
export function drPulse(t: number, v: number, st: Int32Array, o: number): number {
  const p = t < DR_P1 ? v : 0;
  st[o] = (st[o] + (Math.imul(p - st[o], 6650) >> 15)) | 0;
  let s = (p - st[o] + (Math.imul(p, 1442) >> 15)) | 0;
  if (s < 0) s = Math.trunc(Math.imul(s, 727) / (727 - (s >> 4)));
  return s;
}

/** xorshift32 (noise32): the new state as uint32. */
export function noise32(st: Int32Array, o: number): number {
  let s = st[o];
  s ^= s << 13;
  s ^= s >>> 17;
  s ^= s << 5;
  st[o] = s;
  return s >>> 0;
}
