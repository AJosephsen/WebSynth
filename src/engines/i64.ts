// Exact 64-bit multiply-shift helpers for the ports (C int64 arithmetic) using doubles only.

/** floor(a * b / 2^sh) for int32 a and b, 16 <= sh <= 40 (an arithmetic shift of the 64-bit product). */
export function mulsh(a: number, b: number, sh: number): number {
  const bh = b >> 16;
  const bl = b & 0xffff;
  const hi = a * bh; // exact: |a| < 2^31, |bh| <= 2^15
  const lo = a * bl; // exact
  const d = 2 ** (sh - 16);
  const hq = Math.floor(hi / d);
  const hr = hi - hq * d;
  return hq + Math.floor((hr * 65536 + lo) / 2 ** sh);
}

/** (a1*b1 + a2*b2 + a3*b3 + 2^29) >> 30 for int32 values (a resonator step), as an int32. */
export function mac30(a1: number, b1: number, a2: number, b2: number, a3: number, b3: number): number {
  const sumH = a1 * (b1 >> 16) + a2 * (b2 >> 16) + a3 * (b3 >> 16);
  const sumL = a1 * (b1 & 0xffff) + a2 * (b2 & 0xffff) + a3 * (b3 & 0xffff);
  const h1 = Math.floor(sumH / 16384);
  const h0 = sumH - h1 * 16384;
  return (h1 + Math.floor((h0 * 65536 + sumL + 536870912) / 1073741824)) | 0;
}
