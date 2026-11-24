// Port of Melodee's drum_808.c (GPL-3.0-only, Copyright (C) 2026 Kerem Kilic): KIT 808, an analog kit modelled on the TR-808's
// voice circuits, one circuit per lane. The models follow K. J. Werner et al. (DAFx-14, ICMC-SMC 2014) and the service notes'
// frequencies, as the C source states. C int32 arithmetic uses Math.imul / >> / | 0. See NOTICE.
import { clamp, softclip } from "../engines/dsp";
import { CTL } from "../engines/types";
import { fmClampf, fmExp2f } from "./fastmath";
import {
  DR_DUTY, DR_LIFE, DR_P1, DR_PEND, DR_QUIET, DRE_LOW, DRS, Drf, Dre, dr8Level, drBlk, drDamp, drExp, drF, drFreq, drLp1, drMs, drPow2, drPulse,
  drRes, drTau, drTuned, drf, drfBp, drfHp, dreAt, dreNext, int16, mulShr, noise32, pow2q16,
} from "./mdsp";

export const DR_BD = 0, DR_SD = 1, DR_LT = 2, DR_MT = 3, DR_HT = 4, DR_LC = 5, DR_MC = 6, DR_HC = 7, DR_RS = 8, DR_CL = 9, DR_CP = 10, DR_MA = 11,
  DR_CB = 12, DR_CY = 13, DR_OH = 14, DR_CH = 15, DR_N = 16;
const DR_X = 0xff;
/** GM percussion keys 35..81 -> instrument */
const DR_GM = [
  DR_BD, DR_BD, DR_RS, DR_SD, DR_CP, DR_SD, DR_LT, DR_CH, DR_LT, DR_CH, DR_MT, DR_OH, DR_MT, DR_HT, DR_CY, DR_HT, DR_CY, DR_CY, DR_CY, DR_MA, DR_CY, DR_CB,
  DR_CY, DR_X, DR_CY, DR_HC, DR_MC, DR_HC, DR_MC, DR_LC, DR_X, DR_X, DR_X, DR_X, DR_MA, DR_MA, DR_X, DR_X, DR_X, DR_X, DR_CL, DR_CL, DR_CL, DR_X, DR_X, DR_X,
  DR_X,
];
/** the fallback role (DVT_*) -> the 808 instrument */
const DR_OF_DVT = [DR_BD, DR_BD, DR_SD, DR_CP, DR_CH, DR_OH, DR_MT, DR_MC, DR_RS, DR_CL, DR_CB, DR_CY];

const DR8_OUT = 6800;
const DR_NOISY = (1 << DR_SD) | (1 << DR_LT) | (1 << DR_MT) | (1 << DR_HT) | (1 << DR_CP) | (1 << DR_MA);
const DR_BANDS = (1 << DR_CY) | (1 << DR_OH) | (1 << DR_CH);
const DR_METAL = DR_BANDS | (1 << DR_CB);

const DRF_SDN = drf(6206, 1231, 244, 11587);
const DRF_CP = drf(7814, 636, 52, 4201);
const DRF_MA = drf(4921, 1831, 681, 11587);
const DRF_CB = drf(8055, 506, 32, 1707);
const DRF_M1 = drf(7149, 1788, 447, 2731);
const DRF_M2 = drf(5360, 2969, 1644, 3277);
const DRF_CYA = drf(6050, 1313, 285, 11587);
const DRF_CYB = drf(3110, 2886, 2677, 6827);
const DRF_HAT = drf(4449, 2423, 1320, 8192);
const DRF_RS = drf(7558, 431, 25, 11587);

const DR_OSC = [19994485, 35995916, 29645987, 50906562, 77913239, 52591436];

/** The lane's scratch: its noise, the oscillators' sum, band 2 through its swing VCA, the cowbell's two. */
export class Dr8Scratch {
  nz = new Int32Array(CTL);
  m1 = new Int32Array(CTL);
  m2 = new Int32Array(CTL);
  cbx = new Int32Array(CTL);
  inc = new Uint32Array(6);
}

/** the knobs the circuits read (P_E0..P_E7) */
const E1 = 1, E2 = 2, E3 = 3, E4 = 4, E6 = 6;

export class Dr8 {
  t = 0;
  v = 0;
  f = 0; q = 0; f2 = 0; q2 = 0;
  /** lp, bp, lp2, bp2; px in px[0] */
  st = new Int32Array(4);
  px = new Int32Array(1);
  s = new Int32Array(4);
  x = new Int32Array(5);
  m1 = new Int32Array(2);
  m2 = new Int32Array(2);
  e = [new Dre(), new Dre()];
  color = 0;
  ph = new Uint32Array(6);
  decay = 0;
  pitch = 0;
  cacheTune = 0; cacheDecay = 0; cacheTone = 0; cacheF = 0; cacheQ = 0; cacheG = 0; cacheC = 0;
  cacheValid = 0;
  nst = new Int32Array(1);
  ins = 0;
  on = 0;
  choke = 0;

  /** silent: the circuit back to rest (the oscillators and the noise run on) */
  off(): void {
    this.t = this.v = this.f = this.q = this.f2 = this.q2 = 0;
    this.st.fill(0); this.px[0] = 0; this.s.fill(0); this.x.fill(0); this.m1.fill(0); this.m2.fill(0);
    this.e[0].e = this.e[0].k = this.e[1].e = this.e[1].k = 0;
    this.color = 0;
    this.on = this.choke = 0;
  }
}

function dr8Tau(d: Dr8, tau: number): number {
  return d.decay ? Math.floor((tau * drPow2(d.decay * 8)) / 65536) >>> 0 : tau;
}

/** a copy of a base filter with its cutoff moved by pitch (1/16 semitone); float maths as in C */
function dr8Filter(base: Drf, pitch: number): Drf {
  if (!pitch) return base;
  const f = Math.fround;
  let g = f(f(base.a2) / f(base.a1));
  g = fmClampf(f(g * fmExp2f(f(f(pitch) / f(192)))), f(0.001), f(8));
  const k = f(f(base.k) / f(8192));
  const a1 = f(f(1) / f(f(1) + f(g * f(g + k))));
  return drf(int16(f(a1 * f(8192)) | 0), int16(f(f(g * a1) * f(8192)) | 0), int16(f(f(f(g * g) * a1) * f(8192)) | 0), base.k);
}

// ---------------------------------------------------------------- bridged-T voices
const DR_BD_G = 6570, DR_SIGH0 = 4000, DR_LEAK = 7;

function drBd(d: Dr8, p: ArrayLike<number>, acc: Int32Array, n: number): void {
  const tune = (p[E1] - 64) * 3 + d.pitch;
  const round = p[E6] > 0;
  let pk = 0;
  if (!d.cacheValid || d.cacheTune !== tune || d.cacheDecay !== p[E3] || d.cacheTone !== p[E2]) {
    d.cacheTune = tune; d.cacheDecay = p[E3]; d.cacheTone = p[E2]; d.cacheValid = 1;
    d.cacheF = drTuned(drF(49.4), tune);
    d.cacheQ = drDamp(d.cacheF, drTau(drExp(300, p[E3] - 64, 24)));
    d.cacheG = mulShr(DR_BD_G, drPow2(-tune), 16) | 0;
    d.cacheC = drLp1(drExp(1000, p[E2] - 64, 21));
  }
  const f0 = d.cacheF, q = d.cacheQ, g = d.cacheG, c = d.cacheC;
  const s = d.s;
  for (let i = 0; i < n; i++) {
    let x = 0;
    if (d.t < DR_PEND) {
      x = Math.imul(drPulse(d.t, d.v, d.px, 0), 16);
      if (d.t < DR_P1 && !round) s[0] = 32767;
    }
    s[0] -= (s[0] >> 6) + (s[0] > 0 ? 1 : 0);
    let m = Math.imul(s[0], 53412) >> 15;
    if (s[3] > DR_SIGH0) m += (s[3] - DR_SIGH0) >> 1;
    let y = drRes(d.st, 0, d.st, 1, (f0 + (mulShr(f0, m, 15) | 0)) | 0, q, x);
    y = clamp(mulShr(y, g, 16) | 0, -65535, 65535);
    s[3] = y;
    y += x >> DR_LEAK;
    s[1] += Math.imul(y - s[1], c) >> 14;
    s[2] += (Math.imul(s[1], 256) - s[2]) >> 10;
    y = s[1] - (s[2] >> 8);
    acc[i] += y;
    if (y > pk || -y > pk) pk = y < 0 ? -y : y;
    d.t++;
  }
  if (d.t > DR_PEND && pk < DR_QUIET) d.off();
}

const DR_SD_G = 1950, DR_SD_N = 18000;
function drSd(d: Dr8, p: ArrayLike<number>, acc: Int32Array, n: number, sc: Dr8Scratch): void {
  const m = p[E2] * 256, sn = Math.trunc((p[E4] * DR_SD_N) / 64);
  const gl = Math.floor((DR_SD_G * 2 * (32768 - m)) / 32768), gh = Math.floor((DR_SD_G * m) / 32768);
  const de = dreNext(d.e[0]);
  const e0 = DRS[0];
  let pk = 0;
  for (let i = 0; i < n; i++) {
    let x = 0;
    if (d.t < DR_PEND) x = Math.imul(drPulse(d.t, d.v, d.px, 0), 16);
    const a = drRes(d.st, 0, d.st, 1, d.f, d.q, x);
    const b = drRes(d.st, 2, d.st, 3, d.f2, d.q2, x);
    let y = Math.floor((a * gl + b * gh) / 65536) | 0;
    const w = Math.imul(dreAt(e0, de, i), sn) >> 15;
    y += Math.imul(drfHp(DRF_SDN, sc.nz[i], d.s, 0), w) >> 15;
    acc[i] += y;
    if (y > pk || -y > pk) pk = y < 0 ? -y : y;
    d.t++;
  }
  if (d.t > DR_PEND && pk < DR_QUIET && d.e[0].e < DRE_LOW) d.off();
}

/** toms and congas: Hz, the -40 dB time (ms), noise, level / 256 */
const DR_TOM = [
  { hz: 90, ms: 200, nz: 1, g: 255 }, { hz: 135, ms: 130, nz: 1, g: 255 }, { hz: 185, ms: 100, nz: 1, g: 255 },
  { hz: 185, ms: 180, nz: 0, g: 205 }, { hz: 280, ms: 100, nz: 0, g: 205 }, { hz: 400, ms: 80, nz: 0, g: 205 },
];
const DR_TOM_G = 5700, DR_TOM_N = 2400, DR_TOM_DROP = 3932;
function drTom(d: Dr8, p: ArrayLike<number>, acc: Int32Array, n: number, sc: Dr8Scratch): void {
  const k = d.ins - DR_LT;
  const tune = (p[E1] - 64) * 3 + d.pitch;
  let pk = 0;
  if (!d.cacheValid || d.cacheTune !== tune || d.cacheDecay !== d.decay) {
    d.cacheTune = tune; d.cacheDecay = d.decay; d.cacheValid = 1;
    d.cacheF = drTuned(drF(DR_TOM[k].hz), tune);
    d.cacheQ = drDamp(d.cacheF, dr8Tau(d, drTau(DR_TOM[k].ms)));
    // (the product with the uint32 power of two is a 32-bit one in C)
    d.cacheG = (Math.imul(Math.trunc((((DR_TOM_G * DR_TOM[k].g) >> 8) * 100) / DR_TOM[k].hz), drPow2(-tune)) >>> 16) | 0;
  }
  const f0 = d.cacheF, q = d.cacheQ, g = d.cacheG;
  dreNext(d.e[0]);
  const eA = DRS[0];
  const f = (f0 + (mulShr(f0, ((eA >> 9) * DR_TOM_DROP) >> 15, 15) | 0)) | 0;
  const dn = dreNext(d.e[1]);
  const n0 = DRS[0];
  const s = d.s;
  for (let i = 0; i < n; i++) {
    let x = 0;
    if (d.t < DR_PEND) x = Math.imul(drPulse(d.t, d.v, d.px, 0), 16);
    let y = mulShr(drRes(d.st, 0, d.st, 1, f, q, x), g, 16) | 0;
    if (DR_TOM[k].nz) {
      s[0] += Math.imul(sc.nz[i] - s[0], 2700) >> 14;
      y += Math.imul(s[0], Math.imul(dreAt(n0, dn, i), DR_TOM_N) >> 15) >> 15;
    } else {
      y += x >> (DR_LEAK + 2);
    }
    acc[i] += y;
    if (y > pk || -y > pk) pk = y < 0 ? -y : y;
    d.t++;
  }
  if (d.t > DR_PEND && pk < DR_QUIET) d.off();
}

const DR_RS_G = 5000, DR_RS_V = 24, DR_RS_O = 15200;
function drRs(d: Dr8, acc: Int32Array, n: number): void {
  const de = dreNext(d.e[0]);
  const e0 = DRS[0];
  for (let i = 0; i < n; i++) {
    let x = 0;
    if (d.t < DR_PEND) x = Math.imul(drPulse(d.t, d.v, d.px, 0), 16);
    let y = (drRes(d.st, 0, d.st, 1, d.f, d.q, x) + (drRes(d.st, 2, d.st, 3, d.f2, d.q2, x) >> 1)) | 0;
    y = softclip(clamp(Math.imul(mulShr(y, DR_RS_G, 16) | 0, DR_RS_V) >> 4, -200000, 200000));
    y = Math.imul(drfHp(DRF_RS, Math.imul(y, dreAt(e0, de, i)) >> 15, d.s, 0), DR_RS_O) >> 15;
    acc[i] += y;
    d.t++;
  }
  if (d.t > DR_PEND && d.e[0].e < DRE_LOW) d.off();
}

const DR_CL_G = 414;
function drCl(d: Dr8, acc: Int32Array, n: number): void {
  let pk = 0;
  for (let i = 0; i < n; i++) {
    let x = 0;
    if (d.t < DR_PEND) x = Math.imul(drPulse(d.t, d.v, d.px, 0), 16);
    const y = mulShr(drRes(d.st, 0, d.st, 1, d.f, d.q, x), DR_CL_G, 16) | 0;
    acc[i] += y;
    if (y > pk || -y > pk) pk = y < 0 ? -y : y;
    d.t++;
  }
  if (d.t > DR_PEND && pk < DR_QUIET) d.off();
}

// ------------------------------------------------------------------ noise voices
const DR_CP_GAP = 441, DR_CP_N = 3, DR_CP_REV = 9000, DR_CP_G = 10445;
function drCp(d: Dr8, acc: Int32Array, n: number, sc: Dr8Scratch): void {
  const de = dreNext(d.e[0]);
  const e0 = DRS[0];
  const filter: Drf = { a1: int16(d.f), a2: int16(d.f2), a3: int16(d.q), k: DRF_CP.k };
  const s = d.s;
  for (let i = 0; i < n; i++) {
    if (d.t <= DR_CP_N * DR_CP_GAP && d.t === (s[3] >>> 0)) {
      s[2] = (d.v * 151) >> 10;
      s[3] += DR_CP_GAP;
    }
    s[2] -= (s[2] >> (d.t < DR_CP_N * DR_CP_GAP ? 7 : 8)) + (s[2] > 0 ? 1 : 0);
    const w = s[2] + (Math.imul(dreAt(e0, de, i), DR_CP_REV) >> 15);
    const y = Math.imul(Math.imul(drfBp(filter, sc.nz[i], d.s, 0), w) >> 15, DR_CP_G) >> 12;
    acc[i] += y;
    d.t++;
  }
  if (d.t > DR_CP_N * DR_CP_GAP && s[2] < 8 && d.e[0].e < DRE_LOW) d.off();
}

const DR_MA_RISE = 662, DR_MA_G = 23900;
function drMa(d: Dr8, acc: Int32Array, n: number, sc: Dr8Scratch): void {
  const step = Math.trunc(((d.v * 151) >> 10) / DR_MA_RISE);
  const s = d.s;
  for (let i = 0; i < n; i++) {
    if (d.t < DR_MA_RISE) s[2] += step;
    else s[2] -= (s[2] >> 7) + (s[2] > 0 ? 1 : 0);
    const y = Math.imul(Math.imul(drfHp(DRF_MA, sc.nz[i], d.s, 0), s[2]) >> 15, DR_MA_G) >> 15;
    acc[i] += y;
    d.t++;
  }
  if (d.t > DR_MA_RISE && s[2] < 8) d.off();
}

// ------------------------------------------------------------------ metal voices
const DR_MV = 6;
function drMetalTune(d: Dr8, sc: Dr8Scratch): void {
  if (!d.pitch) {
    for (let k = 0; k < 6; k++) sc.inc[k] = DR_OSC[k];
    return;
  }
  const ratio = pow2q16(d.pitch);
  for (let k = 0; k < 6; k++) sc.inc[k] = Math.floor((DR_OSC[k] * ratio) / 65536) >>> 0;
}
const ph6 = new Uint32Array(6);
function drMetal(d: Dr8, n: number, sc: Dr8Scratch): void {
  for (let k = 0; k < 6; k++) ph6[k] = d.ph[k];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < 6; k++) {
      ph6[k] += sc.inc[k];
      sum += ph6[k] < DR_DUTY ? 2048 : -2048;
    }
    sc.cbx[i] = (ph6[4] < DR_DUTY ? 8192 : -8192) + (ph6[5] < DR_DUTY ? 8192 : -8192);
    sc.m1[i] = sum;
  }
  for (let k = 0; k < 6; k++) d.ph[k] = ph6[k];
  if ((DR_BANDS >> d.ins) & 1)
    for (let i = 0; i < n; i++) sc.m2[i] = softclip(clamp(Math.imul(drfBp(DRF_M2, sc.m1[i], d.m2, 0), DR_MV), -200000, 200000));
  if (d.ins === DR_CY) for (let i = 0; i < n; i++) sc.m1[i] = drfBp(DRF_M1, sc.m1[i], d.m1, 0);
}

const DR_CB_G = 26000, DR_CB_FAST = 24576;
function drCb(d: Dr8, acc: Int32Array, n: number, sc: Dr8Scratch): void {
  const de = dreNext(d.e[0]);
  const e0 = DRS[0];
  const dt = dreNext(d.e[1]);
  const t0 = DRS[0];
  for (let i = 0; i < n; i++) {
    const y = softclip(clamp(drfBp(DRF_CB, sc.cbx[i], d.x, 0), -200000, 200000));
    const w = (Math.imul(dreAt(e0, de, i), DR_CB_FAST) >> 15) + (Math.imul(dreAt(t0, dt, i), 32767 - DR_CB_FAST) >> 15);
    acc[i] += Math.imul(Math.imul(y, w) >> 15, DR_CB_G) >> 15;
  }
  d.t += n;
  if (d.e[0].e < DRE_LOW && d.e[1].e < DRE_LOW) d.off();
}

const DR_CY_G = 50000;
function drCy(d: Dr8, p: ArrayLike<number>, acc: Int32Array, n: number, sc: Dr8Scratch): void {
  const s = d.x;
  d.e[0].k = drBlk(drTau(drExp(650, p[E3] - 64, 50)));
  const da = dreNext(d.e[0]);
  const a0 = DRS[0];
  const db = dreNext(d.e[1]);
  const b0 = DRS[0];
  for (let i = 0; i < n; i++) {
    let a = softclip(clamp(Math.imul(sc.m1[i], DR_MV), -200000, 200000));
    let b = sc.m2[i];
    a = drfHp(DRF_CYA, Math.imul(a, dreAt(a0, da, i)) >> 15, s, 0);
    b = drfHp(DRF_CYB, Math.imul(b, dreAt(b0, db, i)) >> 15, s, 2);
    const y = (a * 5 + b * 4) >> 3;
    acc[i] += Math.imul(y - s[4], DR_CY_G) >> 15;
    s[4] = y;
  }
  d.t += n;
  if (d.e[0].e < DRE_LOW && d.e[1].e < DRE_LOW) d.off();
}

const DR_HAT_G = 27000;
function drHat(d: Dr8, p: ArrayLike<number>, acc: Int32Array, n: number, sc: Dr8Scratch): void {
  if (d.ins === DR_OH) d.e[0].k = d.choke ? drBlk(64) : drBlk(drTau(drExp(230, p[E3] - 64, 40)));
  const de = dreNext(d.e[0]);
  const e0 = DRS[0];
  for (let i = 0; i < n; i++) {
    const y = Math.imul(sc.m2[i], dreAt(e0, de, i) >> 1) >> 14;
    acc[i] += Math.imul(drfHp(DRF_HAT, y, d.x, 0), DR_HAT_G) >> 15;
  }
  d.t += n;
  if (d.e[0].e < DRE_LOW) d.off();
}

// ---------------------------------------------------------------- the hits
/** the 808's instrument for a note (the other kits' drum role where its map has none) */
export function dr8Ins(note: number, role: number): number {
  const n = note >= 35 && note <= 81 ? note : 36 + ((note + 120 - 36) % 12);
  const k = DR_GM[n - 35];
  return k === DR_X ? DR_OF_DVT[role % 12] : k;
}

/** lane d struck: instrument ins at velocity vel (its trigger level); p: the knobs (P_E0..P_E7) with the HIT page's edits */
export function dr8Hit(d: Dr8, ins: number, vel: number, p: ArrayLike<number>): void {
  const tune = (p[E1] - 64) * 3 + d.pitch;
  if (!d.nst[0]) d.nst[0] = (0x2f6e2b1 + Math.imul(ins, 0x9e3779b9)) | 0;
  if (d.ins !== ins) d.off();
  const lv = vel * 132104;
  d.cacheValid = 0;
  d.ins = ins;
  d.t = 0;
  d.v = vel * 1742;
  switch (ins) {
    case DR_SD:
      d.f = drTuned(drF(173.3), tune);
      d.q = drDamp(d.f, dr8Tau(d, drMs(18)));
      d.f2 = drTuned(drF(336.0), tune);
      d.q2 = drDamp(d.f2, dr8Tau(d, drMs(9)));
      d.e[0].hit(lv, dr8Tau(d, drMs(45)));
      break;
    case DR_LT: case DR_MT: case DR_HT: case DR_LC: case DR_MC: case DR_HC: {
      const tau = dr8Tau(d, drTau(DR_TOM[ins - DR_LT].ms));
      d.e[0].hit(lv, tau);
      d.e[1].hit(lv, Math.floor((tau * 7) / 10));
      break;
    }
    case DR_RS:
      d.f = drTuned(drF(455), tune);
      d.q = drDamp(d.f, dr8Tau(d, drMs(12)));
      d.f2 = drTuned(drF(1667), tune);
      d.q2 = drDamp(d.f2, dr8Tau(d, drMs(6)));
      d.e[0].hit(lv, dr8Tau(d, drTau(12)));
      break;
    case DR_CL:
      d.f = drTuned(drF(2500), tune);
      d.q = drDamp(d.f, dr8Tau(d, drMs(9)));
      break;
    case DR_CP: {
      const fl = dr8Filter(DRF_CP, d.pitch);
      d.f = fl.a1; d.f2 = fl.a2; d.q = fl.a3;
      d.s[2] = 0;
      d.s[3] = 0;
      d.e[0].hit(lv, dr8Tau(d, drMs(25)));
      break;
    }
    case DR_MA:
      d.s[2] = 0;
      break;
    case DR_CB:
      d.e[0].hit(lv, dr8Tau(d, drTau(50)));
      d.e[1].hit(lv, dr8Tau(d, drTau(500)));
      break;
    case DR_CY:
      d.e[0].hit(lv, 64);
      d.e[1].hit(lv, dr8Tau(d, drMs(40)));
      break;
    case DR_OH:
      d.choke = 0;
      d.e[0].hit(lv, 64);
      break;
    case DR_CH:
      d.e[0].hit(Math.trunc((lv * 3) / 2), dr8Tau(d, drTau(50)));
      break;
  }
  d.on = 1;
}

/** the lane's block into y (n <= CTL): its circuit, the knobs of the part (p) as they are now, at DRUM's level */
export function dr8Run(d: Dr8, p: ArrayLike<number>, y: Int32Array, n: number, sc: Dr8Scratch): void {
  for (let i = 0; i < n; i++) y[i] = 0;
  if (!d.on) return;
  if ((DR_NOISY >> d.ins) & 1) for (let i = 0; i < n; i++) sc.nz[i] = (noise32(d.nst, 0) >>> 17) - 16384;
  if ((DR_METAL >> d.ins) & 1) {
    drMetalTune(d, sc);
    drMetal(d, n, sc);
  }
  switch (d.ins) {
    case DR_BD: drBd(d, p, y, n); break;
    case DR_SD: drSd(d, p, y, n, sc); break;
    case DR_RS: drRs(d, y, n); break;
    case DR_CL: drCl(d, y, n); break;
    case DR_CP: drCp(d, y, n, sc); break;
    case DR_MA: drMa(d, y, n, sc); break;
    case DR_CB: drCb(d, y, n, sc); break;
    case DR_CY: drCy(d, p, y, n, sc); break;
    case DR_OH: case DR_CH: drHat(d, p, y, n, sc); break;
    default: drTom(d, p, y, n, sc); break;
  }
  for (let i = 0; i < n; i++) y[i] = Math.imul(y[i], DR8_OUT) >> 12;
  if (d.t > DR_LIFE) d.off();
}
export { dr8Level, drFreq };
