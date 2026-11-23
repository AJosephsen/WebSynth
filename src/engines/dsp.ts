// Port of Felucca-Engines' dsp.c (MIT): fixed-point oscillators, filter and helpers. See NOTICE.
// C int32 arithmetic is reproduced with Math.imul, |0 and >> ; uint32 with >>> 0.
import { CTL, Vmod } from "./types";
import { PITCH_OCT, SVF_G, TANH_Q15 } from "./tables";
import { SINE } from "../fm6/tables";

export const VOICE_FS = 24000;
export const mulq15 = (a: number, b: number): number => Math.imul(a, b) >> 15;
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
/** a * k / 65536, a up to 2^31, k Q16 (uint). */
export const mulq16 = (a: number, k: number): number => (Math.imul(a >> 16, k) + (((a & 0xffff) * k) >>> 16)) | 0;

/** Phase increment of pitch p in 1/16 semitone, 0..2047. */
export function pitchInc(p: number): number {
  const i = p + 64;
  const o = (i * 21846) >>> 22;
  return PITCH_OCT[i - o * 192] >>> (10 - o);
}

export function sineI(ph: number): number {
  const i = ph >>> 22;
  const a = SINE[i];
  const b = SINE[(i + 1) & 1023];
  return a + (Math.imul(b - a, (ph >>> 7) & 0x7fff) >> 15);
}
export const oscSine = sineI;

/** polyBLEP residual (Q15) around a wrap of a phase accumulator. */
export function blep(ph: number, inc: number): number {
  const d = inc >>> 15;
  if (!d) return 0;
  if (ph < inc) {
    const x = Math.floor(ph / d) | 0;
    return x + x - ((x * x) >> 15) - 32768;
  }
  if (ph > 0xffffffff - inc) {
    const x = -(Math.floor((0xffffffff - ph) / d) | 0);
    return ((x * x) >> 15) + x + x + 32768;
  }
  return 0;
}

export const oscSaw = (ph: number, inc: number): number => (ph >>> 16) - 32768 - blep(ph, inc);
export const oscPulse = (ph: number, inc: number, pw: number): number => (oscSaw(ph, inc) - oscSaw((ph + pw) >>> 0, inc)) >> 1;
export function oscTri(ph: number): number {
  const s = ph >>> 15;
  return s < 65536 ? s - 32768 : 98303 - s;
}

/** tanh(x / 32768) * 32767, linearly interpolated. */
export function softclip(x: number): number {
  const a = x < 0 ? -x : x;
  const i = a >> 8;
  const y = i >= 256 ? TANH_Q15[256] : TANH_Q15[i] + (Math.imul(TANH_Q15[i + 1] - TANH_Q15[i], a & 255) >> 8);
  return x < 0 ? -y : y;
}

/** xorshift32 step: returns the new state (int32); read it as unsigned with >>> 0. */
export function noiseStep(s: number): number {
  s ^= s << 13;
  s ^= s >>> 17;
  s ^= s << 5;
  return s | 0;
}

/** Trapezoidal SVF coefficients (A. Simper), Q13. */
export class Tsvf {
  a1 = 0; a2 = 0; a3 = 0;
  setK(cut: number, k: number): void {
    cut = clamp(cut, 0, 127 << 8);
    const i = cut >> 8;
    let g = SVF_G[i];
    if (i < 127) g += Math.imul(SVF_G[i + 1] - g, cut & 255) >> 8;
    const den = 4096 + (Math.imul(g, g + k) >> 12);
    this.a1 = Math.floor((4096 * 8192) / den) | 0;
    this.a2 = Math.imul(this.a1, g) >> 12;
    this.a3 = Math.imul(this.a2, g) >> 12;
  }
  set(cut: number, reso: number): void {
    this.setK(cut, 8192 - Math.trunc((reso * 7600) / 127));
  }
}

/** One low-pass SVF step; state is s[o], s[o+1]. */
export function tsvfLp(c: Tsvf, input: number, st: Int32Array, o: number): number {
  const v3 = input - st[o + 1];
  const v1 = (Math.imul(c.a1, st[o]) + Math.imul(c.a2, v3)) >> 13;
  const v2 = st[o + 1] + ((Math.imul(c.a2, st[o]) + Math.imul(c.a3, v3)) >> 13);
  st[o] = clamp(2 * v1 - st[o], -150000, 150000);
  st[o + 1] = clamp(2 * v2 - st[o + 1], -150000, 150000);
  return v2;
}

export function ampAt(m: Vmod, i: number): number {
  const x = Math.imul(m.amp1 - m.amp0, i);
  return m.amp0 + ((x + ((x >> 31) & (CTL - 1))) >> 5);
}

/** A voice's sample (Q15) at the amplitude ramp's sample i, scaled to the voice level. */
export const voiceAmp = (s: number, m: Vmod, i: number): number => mulq15(mulq15(s, ampAt(m, i)), VOICE_FS);

/** Linear up to k, then a soft knee. */
export function softKnee(y: number, k: number): number {
  let a = y < 0 ? -y : y;
  if (a <= k) return y;
  a = k + (softclip((a - k) * 2) >> 1);
  return y < 0 ? -a : a;
}

/** Phase increment of pitch16 plus ct cents. */
export function centsInc(pitch16: number, ct: number, fine: number): number {
  const d16 = Math.trunc((ct * 16) / 100);
  const rem = ct * 16 - d16 * 100;
  const inc = pitchInc(clamp(pitch16 + d16, 0, 2047));
  return (inc + Math.imul(inc >>> 12, Math.trunc((rem * 2367) / 16000) + fine)) >>> 0;
}
