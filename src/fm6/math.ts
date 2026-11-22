// Port of fm6_core.c math (msfa Exp2 / Freqlut / sine). See NOTICE.
import { EXP2, FREQ_R, SINE } from "./tables";

/** Q30 mantissa 2^(frac) of a Q24 log2 value. */
export function mant(x: number): number {
  const f = x & 0xffffff;
  const k = f >> 14;
  const a = EXP2[k];
  return 2 ** 30 + a + Math.floor(((EXP2[k + 1] - a) * (f & 0x3fff)) / 16384);
}

/** 2^(x / 2^24), Q24. */
export function exp2(x: number): number {
  const i = x >> 24;
  if (i < -24) return 0;
  return Math.floor(mant(x) / 2 ** (i > 5 ? 1 : 6 - i)) | 0;
}

/** Phase increment (Q24 cycles per sample) of a Q24 log2 frequency. */
export function freq(x: number): number {
  const i = x >> 24;
  if (i < 0) return 0;
  const q = Number((BigInt(mant(x)) * BigInt(FREQ_R)) >> 25n);
  return Math.floor(q / 2 ** (21 - (i > 21 ? 21 : i))) | 0;
}

/** Sine of a Q24 phase (one cycle = 2^24), Q15, linearly interpolated. */
export function sin(ph: number): number {
  const idx = (ph >>> 14) & 1023;
  const s0 = SINE[idx];
  return s0 + (((SINE[idx + 1] - s0) * (ph & 0x3fff)) >> 14);
}
