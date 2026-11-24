// Port of the single-precision maths of Melodee's x0x/fastmath.h (GPL-3.0-only, Kerem Kilic; from fm1-x0x by Charles Vestal). See NOTICE.
// Every C float operation is rounded to float32 with Math.fround, in the order of the C expressions (the device and the
// reference build have no fused multiply-add).
const f = Math.fround;

export const FM_PI = f(3.14159265358979);
export const FM_TWO_PI = f(6.28318530717959);
export const FM_LN2 = f(0.693147180559945);
export const FM_LOG2E = f(1.44269504088896);

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);
const I32 = new Int32Array(F32.buffer);

export const fmFabsf = (x: number): number => (x < 0 ? -x : x === 0 ? 0 : x);
export const fmClampf = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** floor for |x| < 2^31 */
export function fmFloorf(x: number): number {
  const i = x | 0;
  const fl = f(i);
  return fl > x ? f(fl - 1) : fl;
}

/** 2^n * 2^fr for an integer n and |fr| <= 0.5 */
export function fmExp2Nf(n: number, fr: number): number {
  if (n < -126) return 0;
  let p = f(1.534580891e-04);
  p = f(f(p * fr) + f(1.339993158e-03));
  p = f(f(p * fr) + f(9.618488972e-03));
  p = f(f(p * fr) + f(5.550328776e-02));
  p = f(f(p * fr) + f(2.402264689e-01));
  p = f(f(p * fr) + f(6.931472057e-01));
  p = f(f(p * fr) + 1);
  F32[0] = p;
  U32[0] = (U32[0] + (n << 23)) >>> 0;
  return F32[0];
}

export function fmExp2f(x: number): number {
  if (x < -126) return 0;
  if (x > 127) x = 127;
  const fl = fmFloorf(f(x + f(0.5)));
  return fmExp2Nf(fl | 0, f(x - fl));
}

export function fmExpf(x: number): number {
  if (x < f(-87.3)) return 0;
  if (x > f(88.7)) x = f(88.7);
  const n = fmFloorf(f(f(x * FM_LOG2E) + f(0.5)));
  x = f(f(x - f(n * f(0.693145752))) - f(n * f(1.42860677e-6)));
  return fmExp2Nf(n | 0, f(x * FM_LOG2E));
}

export function fmLog2f(x: number): number {
  F32[0] = x;
  if (I32[0] <= 0) return -127;
  let e = ((I32[0] >> 23) & 0xff) - 127;
  I32[0] = (I32[0] & 0x007fffff) | 0x3f800000;
  let m = F32[0];
  if (m > f(1.41421356)) {
    m = f(m * f(0.5));
    e += 1;
  }
  const t = f(f(m - 1) / f(m + 1));
  const t2 = f(t * t);
  let p = f(3.428278367e-01);
  p = f(f(p * t2) + f(4.115337810e-01));
  p = f(f(p * t2) + f(5.770866525e-01));
  p = f(f(p * t2) + f(9.617966483e-01));
  p = f(f(p * t2) + f(2.885390082e+00));
  return f(f(e) + f(p * t));
}

/** sin on [-pi, pi]: odd polynomial, degree 13 */
export function fmSinPi(x: number): number {
  const x2 = f(x * x);
  let p = f(1.345176048e-10);
  p = f(f(p * x2) - f(2.467706523e-08));
  p = f(f(p * x2) + f(2.752946668e-06));
  p = f(f(p * x2) - f(1.984015614e-04));
  p = f(f(p * x2) + f(8.333310417e-03));
  p = f(f(p * x2) - f(1.666666459e-01));
  p = f(f(p * x2) + f(9.999999946e-01));
  return f(p * x);
}

function fmWrapPi(x: number): number {
  const k = fmFloorf(f(f(x * f(1 / FM_TWO_PI)) + f(0.5)));
  return f(f(f(x - f(k * f(6.28125))) - f(k * f(1.9353071693331003e-3))) - f(k * f(1.0253131561401567e-11)));
}

export const fmSinf = (x: number): number => fmSinPi(fmWrapPi(x));

/** tan on (-pi/2, pi/2): the filter-coefficient range */
export function fmTanf(x: number): number {
  const a = fmFabsf(x);
  const c = f(f(f(1.57079637) - a) - f(4.37113883e-8));
  return f(fmSinPi(x) / fmSinPi(c));
}
