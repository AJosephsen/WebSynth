// Port of Felucca's eng_formant.c (GPL-3.0-only): the VOICE engine, a Klatt formant synthesiser singing vowels.
// See NOTICE.
import { blep, clamp, noiseStep, sineI, softKnee, voiceAmp } from "./dsp";
import { ENV_LIN } from "./felucca-tables";
import { mac30, mulsh } from "./i64";
import { EngineDef, EngVoice, F, P_E0, P_E1, P_E2, P_E3, P_E4, P_E5, P_E6, P_E7, Track, Vmod } from "./types";

const FOLOW = 30;
const TALK_MASK = 0x01ffffff;
const VOWEL_F = [[768, 1333, 2522], [580, 1799, 2605], [342, 2322, 3000], [497, 910, 2459], [378, 997, 2343]];
const VOWEL_B = [[90, 100, 160], [70, 100, 170], [50, 120, 200], [70, 80, 150], [60, 80, 150]];
const SEMI_Q16 = [65536, 69433, 73562, 77936, 82570, 87480, 92682, 98193, 104032, 110218, 116772, 123715, 131072];

/** 2^(st16 / 192) in Q16, clamped to 1/16 .. 16. */
function ratioOf(st16: number): number {
  st16 = clamp(st16, -4 * 192, 4 * 192 - 1) + 4 * 192;
  const o = (st16 * 2731) >> 19;
  const k = st16 - o * 192;
  const r = SEMI_Q16[k >> 4] + (((SEMI_Q16[(k >> 4) + 1] - SEMI_Q16[k >> 4]) * (k & 15)) >> 4);
  return o >= 4 ? (r << (o - 4)) >>> 0 : r >>> (4 - o);
}

/** The three formants of vowel position pos (0..127 << 8), Hz * 16. */
function vowelAt(pos: number, f: number[], b: number[]): void {
  const x = (clamp(pos, 0, 127 << 8) * 33027) >> 20;
  let i = x >> 8;
  let fr = x & 255;
  if (i >= 4) { i = 3; fr = 256; }
  for (let j = 0; j < 3; j++) {
    f[j] = (VOWEL_F[i][j] << 4) + (((VOWEL_F[i + 1][j] - VOWEL_F[i][j]) * fr) >> 4);
    b[j] = (VOWEL_B[i][j] << 4) + (((VOWEL_B[i + 1][j] - VOWEL_B[i][j]) * fr) >> 4);
  }
}

class Fres { a = 0; b = 0; c = 0; }

/** Klatt resonator coefficients (Q30) for F, BW in Hz * 16. */
function fresCoef(r: Fres, f16: number, bw16: number): void {
  const s = sineI(Math.imul(f16, 3044) >>> 0);
  const x = Math.imul(bw16, 4781);
  const x2 = mulsh(x, x, 30);
  const x3 = mulsh(x2, x, 30);
  const x4 = mulsh(x3, x, 30);
  const e = (1 << 30) - x + (x2 >> 1) - mulsh(x3, 178956971, 30) + mulsh(x4, 44739243, 30);
  const cs = (1 << 30) - 2 * s * s;
  r.b = mulsh(e, cs, 29);
  r.c = -mulsh(e, e, 30);
  r.a = ((1 << 30) - r.b - r.c) | 0;
}

/** Breath noise: one xorshift for all voices (as in the C build). */
let nz = 0x2545f491;

function noteOn(_t: Track, v: EngVoice): void {
  nz = noiseStep(nz);
  v.s[7] = ((nz >>> 0) >>> 25) << 25;
  if (!v.env && !v.envOut) {
    v.ph[0] = 0;
    v.ph[1] = v.ph[2] = 0;
    for (let i = 0; i < 7; i++) v.s[i] = 0;
  }
}

const fa = [0, 0, 0], ba = [0, 0, 0], fb = [0, 0, 0], bb = [0, 0, 0];
const r1 = new Fres(), r2 = new Fres(), r3 = new Fres(), r4 = new Fres();

function render(t: Track, v: EngVoice, out: Int32Array, n: number, m: Vmod): void {
  const p = t.p;
  const inc = m.inc;
  let ph = v.ph[0];
  let y1 = v.s[0], y2 = v.s[1], y3 = v.s[2], y4 = v.s[3], y5 = v.s[4], y6 = v.s[5];
  let y7 = v.ph[1] | 0, y8 = v.ph[2] | 0, lp = v.s[6], nst = nz;
  let k = 0;
  if (p[P_E2]) {
    let g = ((v.s[7] >>> 0) & TALK_MASK) + ENV_LIN[p[P_E2] & 127];
    g = g > 1 << 24 ? 1 << 24 : g;
    v.s[7] = ((((v.s[7] >>> 0) & ~TALK_MASK) >>> 0) | g) | 0;
    k = g >>> 9;
    k = (k * (65536 - k)) >> 15;
  }
  {
    const rv = ((v.s[7] >>> 0) >>> 25) << 8;
    let v0 = p[P_E0] << 8, v1 = p[P_E1] << 8;
    v0 += ((rv - v0) * p[P_E7] * 258) >> 15;
    v1 += ((rv - v1) * p[P_E7] * 258) >> 15;
    vowelAt(v0 + m.cutoff, fa, ba);
    vowelAt(v1 + m.cutoff, fb, bb);
  }
  const ratio = ratioOf(p[P_E3] * 16 + ((FOLOW * (v.pitchCur - 60 * 16) * 516) >> 16));
  const bws = ratioOf((64 - p[P_E6]) * 4);
  const f0 = Math.floor((inc * 705600) / 4294967296);
  for (let j = 0; j < 3; j++) {
    let f = fa[j] + (((fb[j] - fa[j]) * k) >> 15);
    let b = ba[j] + (((bb[j] - ba[j]) * k) >> 15);
    f = mulsh(f, ratio, 16);
    b = mulsh(mulsh(b, ratio, 16), bws, 16);
    if (j === 0 && f >= 0 && f < f0 + (f0 >>> 4) && f > 0) {
      b = Math.trunc((b * (f0 + (f0 >>> 4))) / f);
      f = f0 + (f0 >>> 4);
    }
    fa[j] = clamp(f, 60 * 16, 7000 * 16);
    ba[j] = clamp(b, 20 * 16, 1500 * 16);
  }
  fresCoef(r1, fa[0], ba[0]);
  fresCoef(r2, fa[1], ba[1]);
  fresCoef(r3, fa[2], ba[2]);
  fresCoef(
    r4,
    clamp(Math.floor((3300 * 16 * ratio) / 65536), 60 * 16, 7000 * 16),
    clamp(Math.floor((Math.floor((250 * 16 * ratio) / 65536) * bws) / 65536), 20 * 16, 1500 * 16),
  );
  const buzz = clamp((p[P_E4] << 8) + m.shape - (64 << 8) + (v.vel - 96) * 40, 0, 127 << 8);
  const oq = 58982 - ((buzz * 284) >> 8);
  const tilt = 2500 + ((buzz * 109) >> 8);
  const te = (oq << 16) >>> 0;
  const tp = Math.imul(te >>> 8, 166) >>> 0;
  const rp = Math.floor(1073741824 / (((tp >>> 16) | 1) >>> 0));
  const rn = Math.floor(1073741824 / ((((te - tp) >>> 0) >>> 16) | 1));
  const gv = 32767 - p[P_E5] * p[P_E5] * 2;
  const gn = p[P_E5] * 258;
  let og = 13000 - (p[P_E6] - 64) * 50;
  og = mulsh(og, ratioOf(Math.trunc((60 * 16 - v.pitchCur) / 4)), 16);
  const ogk = (og >> 2) * (4 + (buzz >> 10));
  for (let i = 0; i < n; i++) {
    let e: number;
    if (ph < tp) e = Math.imul(sineI((Math.imul(ph >>> 16, rp) << 1) >>> 0), 17644) >> 15;
    else if (ph < te) e = -sineI(Math.imul((ph - tp) >>> 16, rn) >>> 0);
    else e = 0;
    e += blep((ph - te) >>> 0, inc) >> 1;
    lp += Math.imul(e - lp, tilt) >> 14;
    let x = Math.imul(lp, gv) >> 15;
    if (gn) {
      nst = noiseStep(nst);
      const nzv = Math.imul(((nst >>> 0) >>> 16) - 32768, gn) >> 15;
      x += ph < te ? nzv : nzv >> 1;
    }
    let a = mac30(r1.a, x << 6, r1.b, y1, r1.c, y2);
    y2 = y1; y1 = a;
    a = mac30(r2.a, a, r2.b, y3, r2.c, y4);
    y4 = y3; y3 = a;
    a = mac30(r3.a, a, r3.b, y5, r3.c, y6);
    y6 = y5; y5 = a;
    a = mac30(r4.a, a, r4.b, y7, r4.c, y8);
    y8 = y7;
    y7 = clamp(a, -(1 << 28), 1 << 28);
    const s = softKnee(clamp(Math.floor((y7 * og + (y7 - y8) * ogk) / 2097152), -200000, 200000), 24000);
    ph = (ph + inc) >>> 0;
    out[i] += voiceAmp(s, m, i) << 1;
  }
  v.ph[0] = ph;
  v.ph[1] = y7 >>> 0;
  v.ph[2] = y8 >>> 0;
  nz = nst;
  v.s[0] = y1; v.s[1] = y2; v.s[2] = y3; v.s[3] = y4; v.s[4] = y5; v.s[5] = y6; v.s[6] = lp;
}

export const ENG_FORMANT: EngineDef = {
  name: "VOICE",
  pageTitle: ["VOWL", "TONE"],
  edit: [
    { label: "VOWL", fmt: F.INT, min: 0, max: 127, def: 0 },
    { label: "VOWL2", fmt: F.INT, min: 0, max: 127, def: 64 },
    { label: "TALK", fmt: F.TIME, min: 0, max: 127, def: 0 },
    { label: "SHIFT", fmt: F.SEMI, min: -12, max: 12, def: 0 },
    { label: "BUZZ", fmt: F.PCT, min: 0, max: 127, def: 64 },
    { label: "BRTH", fmt: F.PCT, min: 0, max: 127, def: 10 },
    { label: "Q", fmt: F.PCT, min: 0, max: 127, def: 64 },
    { label: "RAND", fmt: F.PCT, min: 0, max: 127, def: 0 },
  ],
  knob: [P_E0, P_E4, P_E5, P_E2],
  keep: 0,
  noteOn,
  render,
};
