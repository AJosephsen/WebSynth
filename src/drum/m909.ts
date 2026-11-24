// Port of the TR-909 drum voices of Melodee (x0x/drum909.c, drum909_dsp.h, drum_909 part of eng_drum.c; GPL-3.0-only, Kerem Kilic).
// Melodee imported them from Charles Vestal's fm1-x0x (GPL-3.0-only), which credits 9W9 by athousanddetails, derived from ER99 by
// Matthew Cieplak. The cymbals and hats are Melodee's synthesized approximations, not a sample ROM. See NOTICE.
// All of it is single-precision: every C float operation is rounded with Math.fround, in the order of the C expressions.
import { CTL } from "../engines/types";
import { fmClampf, fmExp2f, fmExpf, fmFabsf, fmLog2f, fmSinf, FM_LN2, FM_PI } from "./fastmath";

const f = Math.fround;
export const D9_BD = 0, D9_SD = 1, D9_LT = 2, D9_MT = 3, D9_HT = 4, D9_RS = 5, D9_CP = 6, D9_CH = 7, D9_OH = 8, D9_CR = 9, D9_RD = 10, D9_NUM = 11;

const D9_SR = 44100;
export const D9_MS = f(f(0.001) * D9_SR);
const D9_MIN_EXP = f(1.0e-9);
const D9_PHASE_PER_HZ = f(97391.548752834467);
const D9_VCA_VT = f(0.0002);
const D9_VCA_NORM = f(f(1) / f(f(1) - D9_VCA_VT));
const D9_SNAPPY_MIX = f(1.95);
const D9_BD_BASE_HZ = 49;
const D9_BD_DF_PER_MS = f(4.6);
const D9_BD_PHOLD_MS = 16;
const D9_INV_TANH_1_6 = f(1.0849887132644653);
const D9_INV_TANH_2_0 = f(1.037314772605896);
const D9_PH_QUARTER = 0x40000000;
const D9_NZ_HIST = 256;
const D9_NZ_BUF = D9_NZ_HIST + 2 * CTL;

/** tanh(i / 128) for i = 0..1024 (Prophet's P5_TANH) */
/** the float nearest to a decimal literal (a C float literal rounds once, from the decimal, not through a double) */
function decimalToFloat(lit: string): number {
  const m = /^(-?)(\d)\.(\d+)e([+-]\d+)$/.exec(lit);
  if (!m) return Math.fround(Number(lit));
  const digits = BigInt(m[2] + m[3]);
  const e10 = Number(m[4]) - m[3].length; // value = digits * 10^e10
  const x = Math.fround(Number(lit));
  const step = (a: number, up: boolean): number => {
    const F = new Float32Array([a]);
    const U = new Uint32Array(F.buffer);
    U[0] += up === a >= 0 ? 1 : -1;
    return F[0];
  };
  // the two floats around the decimal: x and the neighbour on the side the decimal is on, compared exactly at the midpoint
  const dec = (v: number): number => (Number(lit) > v ? 1 : Number(lit) < v ? -1 : 0);
  const nb = dec(x) >= 0 ? step(x, true) : step(x, false);
  const lo = Math.min(x, nb), hi = Math.max(x, nb);
  // exact: digits * 10^e10 against (lo + hi) / 2, both as rationals on a power-of-two grid
  const grid = (v: number): bigint => BigInt(v * 2 ** 160); // v * 2^160: exact for a float
  const mid2 = grid(lo) + grid(hi); // 2 * midpoint * 2^160
  const lhs = e10 >= 0 ? digits * 10n ** BigInt(e10) * 2n ** 161n : digits * 2n ** 161n;
  const rhs = e10 >= 0 ? mid2 : mid2 * 10n ** BigInt(-e10);
  if (lhs === rhs) return x; // a tie: even
  return lhs > rhs ? hi : lo;
}
export const TANH_TAB = new Float32Array(1025);
for (let i = 0; i < 1025; i++) TANH_TAB[i] = decimalToFloat(Math.tanh(i / 128).toExponential(9)); // (the generator writes %.9e)
const TANH_SCALE = f(1024 / 8);

/** 9W9's EXP pot ranges (er99_pots.h): value = min * 2^(log2(max / min) * pot / 127) */
const EXP_RANGES: [number, number][] = [
  [100, 4000], [0.43, 4.7], [0.85, 12], [130, 320], [300, 4000], [50, 90], [80, 2600], [80, 125], [70, 2200], [110, 170], [60, 2000], [150, 300],
  [650, 1400], [120, 1000], [20, 1200], [15, 300], [100, 3000], [0.25, 4],
];
const X_BD_DECAY = 0, X_BD_PITCH = 1, X_DRIVE = 2, X_SD_TUNE = 3, X_SD_TONE = 4, X_LT_TUNE = 5, X_LT_DECAY = 6, X_MT_TUNE = 7, X_MT_DECAY = 8,
  X_HT_TUNE = 9, X_HT_DECAY = 10, X_RS_TUNE = 11, X_CP_TUNE = 12, X_CP_TAIL = 13, X_OH_DECAY = 14, X_CH_DECAY = 15, X_CY_DECAY = 16, X_SMP_PITCH = 17;
const POT_LO = EXP_RANGES.map(([lo]) => f(lo));
const POT_L2 = EXP_RANGES.map(([lo, hi]) => f(Math.log2(f(f(hi) / f(lo)))));

function d9ExpSmall(x: number): number {
  if (x < f(-0.35) || x > f(0.35)) return fmExpf(x);
  let p = f(1 + f(x * f(1 / 8)));
  p = f(1 + f(f(x * f(1 / 7)) * p));
  p = f(1 + f(f(x * f(1 / 6)) * p));
  p = f(1 + f(f(x * f(1 / 5)) * p));
  p = f(1 + f(f(x * f(1 / 4)) * p));
  p = f(1 + f(f(x * f(1 / 3)) * p));
  p = f(1 + f(f(x * f(0.5)) * p));
  return f(1 + f(x * p));
}
/** ceil for 0 <= x < 2^31 */
export function d9Ceil(x: number): number {
  const i = x | 0;
  return f(i) < x ? i + 1 : i;
}

// ------------------------------------------------------------------ envelopes
export class Env {
  v = 0; cur = 0; r = 0; v0 = 0; v1 = 0; l2r = 0; t1 = 0; k = 0; left = 0;
}
function envSet(e: Env, v: number): void {
  e.v = v; e.cur = v; e.v1 = v; e.left = 0;
}
/** exponentialRampToValueAtTime(v1, now + t1 samples) */
export function envExp(e: Env, v1: number, t1: number): void {
  const v0 = e.cur < D9_MIN_EXP ? D9_MIN_EXP : e.cur;
  if (v1 < D9_MIN_EXP) v1 = D9_MIN_EXP;
  if (!(t1 > 0)) t1 = 1;
  e.v0 = v0; e.v1 = v1; e.t1 = t1;
  e.k = d9Ceil(t1) - 1;
  e.left = e.k;
  if (e.k <= 0) {
    e.left = 0; e.v = v1; e.cur = v0;
    return;
  }
  e.l2r = fmLog2f(f(v1 / v0));
  e.r = d9ExpSmall(f(f(e.l2r * FM_LN2) / t1));
  e.v = v0;
  e.cur = v0;
}
function envTick(e: Env): number {
  const o = e.v;
  e.cur = o;
  if (e.left) {
    if (--e.left) e.v = f(e.v * e.r);
    else e.v = e.v1;
  }
  return o;
}
function envAnchor(e: Env): void {
  if (e.left) e.v = f(e.v0 * fmExp2f(f(e.l2r * f(f(e.k - e.left) / e.t1))));
}

// ------------------------------------------------------------------ biquads
const D9_LP = 0, D9_HP = 1, D9_BP = 2;
export class Biquad {
  b0 = 0; b1 = 0; b2 = 0; a1 = 0; a2 = 0; x1 = 0; x2 = 0; y1 = 0; y2 = 0;
}
function biquadSet(fl: Biquad, type: number, freq: number, q: number): void {
  let fc = f(freq / f(f(D9_SR) * f(0.5)));
  if (fc >= 1) fc = f(0.9999);
  if (fc <= 0) fc = f(0.0001);
  const w0 = f(FM_PI * fc);
  const sh = fmSinf(f(f(0.5) * w0));
  const cosw0 = f(1 - f(f(2 * sh) * sh));
  const sinw0 = fmSinf(w0);
  if (q < f(0.0001)) q = f(0.0001);
  const alpha = f(sinw0 / f(2 * q));
  let b0: number, b1: number, b2: number;
  const a0 = f(1 + alpha), a1 = f(f(-2) * cosw0), a2 = f(1 - alpha);
  if (type === D9_LP) {
    b0 = f(f(1 - cosw0) * f(0.5)); b1 = f(1 - cosw0); b2 = f(f(1 - cosw0) * f(0.5));
  } else if (type === D9_HP) {
    b0 = f(f(1 + cosw0) * f(0.5)); b1 = -f(1 + cosw0); b2 = f(f(1 + cosw0) * f(0.5));
  } else {
    b0 = alpha; b1 = 0; b2 = -alpha;
  }
  const inv = f(1 / a0);
  fl.b0 = f(b0 * inv); fl.b1 = f(b1 * inv); fl.b2 = f(b2 * inv);
  fl.a1 = f(a1 * inv); fl.a2 = f(a2 * inv);
}
const biquadReset = (fl: Biquad): void => { fl.x1 = fl.x2 = fl.y1 = fl.y2 = 0; };
function biquadTick(fl: Biquad, input: number): number {
  const y = f(f(f(f(f(fl.b0 * input) + f(fl.b1 * fl.x1)) + f(fl.b2 * fl.x2)) - f(fl.a1 * fl.y1)) - f(fl.a2 * fl.y2));
  fl.x2 = fl.x1; fl.x1 = input;
  fl.y2 = fl.y1; fl.y1 = y;
  return y;
}

// ------------------------------------------------------------------ oscillators, shaper, noise
const d9Inc = (hz: number): number => Math.trunc(f(hz * D9_PHASE_PER_HZ)) >>> 0;
/** 4p - 1 rising over the first half, 3 - 4p falling over the second */
function d9Tri(ph: number): number {
  const u = (ph ^ ((ph | 0) >> 31)) >>> 0;
  return f(f(f(u | 0) * f(1 / 1073741824)) - 1);
}
function d9Tanh(u: number): number {
  const a = f(fmFabsf(u) * TANH_SCALE);
  let t: number;
  if (a >= 1024) {
    t = 1;
  } else {
    const i = a | 0;
    const fr = f(a - i);
    t = f(TANH_TAB[i] + f(f(TANH_TAB[i + 1] - TANH_TAB[i]) * fr));
  }
  return u < 0 ? -t : t;
}
/** the voice's distortion stage: the diode pair, the only type the kit sets (DIST 0) */
interface Shape { k: number; g: number }
function shapePrep(s: Shape, drive: number): void {
  const k = drive > f(0.01) ? drive : f(0.01);
  s.k = k;
  s.g = f(1 / d9Tanh(k));
}
const d9Shape = (s: Shape, x: number): number => f(d9Tanh(f(s.k * x)) * s.g);
const d9Diode16 = (x: number): number => f(d9Tanh(f(f(1.6) * x)) * D9_INV_TANH_1_6);
const d9Diode20 = (x: number): number => f(d9Tanh(f(2 * x)) * D9_INV_TANH_2_0);
function d9Noise(s: Uint32Array, o: number): number {
  let x = s[o];
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  s[o] = x;
  return f(f(f(x >>> 0) * f(1 / 2147483648)) - 1);
}

// ------------------------------------------------------------------ voices
class Bt {
  tune = 0; sweepDepth = 0; sweepTime = 0; decay = 0; attack = 0; clickTone = 0; level = 0;
  tune2 = 0; osc2Mix = 0; snappy = 0; noiseDecay = 0; noiseHp = 0; ampHold = 0; pitchMod = 0; drive = 0;
  shape: Shape = { k: 0, g: 0 };
  ph = 0; ph2 = 0;
  pitch = new Env(); amp = new Env(); clickEnv = new Env(); noiseEnv = new Env();
  clickLp = new Biquad(); noiseHpf = new Biquad(); noiseLpf = new Biquad(); dcBlock = new Biquad();
  noiseHold = 0; noiseGated = 0; ampHoldLeft = 0; bdPhold = 0; impulse = 0; mute = 0; clickStale = 0; clickWarm = 0;
  bdDf = 0; bdMult = 0; bdBase = 0; outGain = 0;
}
class Tom {
  ph = new Uint32Array(3);
  env = [new Env(), new Env(), new Env()];
  pitch = new Env(); noiseEnv = new Env();
  noiseBp = new Biquad(); dcBlock = new Biquad();
  outGain = 0; noiseLevel = 0; mute = 0; stickStale = 0; stickWarm = 0;
}
class Rim {
  tune = 0; tune2 = 0; res = 0; decay = 0; noiseMix = 0; drive = 0; level = 0; accent = 0;
  shape: Shape = { k: 0, g: 0 };
  bp1 = new Biquad(); bp2 = new Biquad(); hp = new Biquad(); amp = new Env();
  impulse = 0; mute = 0;
}
class Clap {
  tune = 0; res = 0; spread = 0; burstDecay = 0; tailDecay = 0; tailLevel = 0; drive = 0; level = 0; accent = 0;
  shape: Shape = { k: 0, g: 0 };
  bp = new Biquad(); hp = new Biquad(); burst = new Env(); tail = new Env();
  nextPulse = 0; pulseIndex = 0; mute = 0;
}
class Smp {
  decay = 0; volume = 0; pitch = 0; drive = 0;
  shape: Shape = { k: 0, g: 0 };
  ph = new Uint32Array(6); noise = new Uint32Array(1);
  bp = new Biquad(); hp = new Biquad();
  playing = 0; kind = 0; out = new Env(); mute = 0;
}

const rimRetune = (v: Rim): void => {
  biquadSet(v.bp1, D9_BP, v.tune, v.res);
  biquadSet(v.bp2, D9_BP, v.tune2, f(v.res * f(1.1)));
};
const clapRetune = (v: Clap): void => biquadSet(v.bp, D9_BP, v.tune, v.res);
function smpRate(s: Smp): void {
  const pitch = s.pitch > 0 ? s.pitch : 1;
  biquadSet(s.bp, D9_BP, f((s.kind < 2 ? 9000 : 6200) * pitch), f(1.3));
  biquadSet(s.hp, D9_HP, s.kind < 2 ? 6800 : 4000, f(0.7071));
}

// ------------------------------------------------------------------ panel (the pots the kit sets)
const F_TUNE = 0, F_ATTACK = 1, F_DECAY = 2, F_LEVEL = 3, F_PDEPTH = 4, F_PITCH = 5, F_DRIVE = 6, F_DIST = 7, F_TONE = 8, F_SNAPPY = 9, F_TAIL = 10;
interface Spec { field: number; exp: number; lo: number; hi: number; def: number; max: number }
const LIN = (field: number, def: number, lo: number, hi: number): Spec => ({ field, exp: -1, lo: f(lo), hi: f(hi), def, max: 127 });
const EXPS = (field: number, def: number, exp: number): Spec => ({ field, exp, lo: 0, hi: 0, def, max: 127 });
const LEVEL = (def: number): Spec => LIN(F_LEVEL, def, 0, 1.35);
const DRIVE = (def: number): Spec => EXPS(F_DRIVE, def, X_DRIVE);
const DIST: Spec = { field: F_DIST, exp: -2, lo: 0, hi: 0, def: 0, max: 6 };
export const D9_SPECS: Spec[][] = [
  [LIN(F_TUNE, 34, 6, 32), LIN(F_ATTACK, 13, 0, 1), EXPS(F_DECAY, 90, X_BD_DECAY), LEVEL(94), LIN(F_PDEPTH, 0, 0, 1), EXPS(F_PITCH, 45, X_BD_PITCH), DRIVE(0), DIST],
  [EXPS(F_TUNE, 64, X_SD_TUNE), EXPS(F_TONE, 68, X_SD_TONE), LIN(F_SNAPPY, 64, 0, 1), LEVEL(58), DRIVE(36), DIST],
  [EXPS(F_TUNE, 66, X_LT_TUNE), EXPS(F_DECAY, 111, X_LT_DECAY), LEVEL(52), LIN(F_ATTACK, 23, 0, 1), DRIVE(41), DIST],
  [EXPS(F_TUNE, 69, X_MT_TUNE), EXPS(F_DECAY, 100, X_MT_DECAY), LEVEL(52), LIN(F_ATTACK, 23, 0, 1), DRIVE(41), DIST],
  [EXPS(F_TUNE, 53, X_HT_TUNE), EXPS(F_DECAY, 105, X_HT_DECAY), LEVEL(52), LIN(F_ATTACK, 23, 0, 1), DRIVE(41), DIST],
  [LEVEL(103), EXPS(F_TUNE, 62, X_RS_TUNE), DRIVE(24), DIST],
  [LEVEL(122), EXPS(F_TUNE, 63, X_CP_TUNE), EXPS(F_TAIL, 63, X_CP_TAIL), DRIVE(30), DIST],
  [EXPS(F_DECAY, 84, X_CH_DECAY), LEVEL(89), EXPS(F_TUNE, 64, X_SMP_PITCH), DRIVE(0), DIST],
  [EXPS(F_DECAY, 97, X_OH_DECAY), LEVEL(80), EXPS(F_TUNE, 64, X_SMP_PITCH), DRIVE(0), DIST],
  [EXPS(F_TUNE, 64, X_SMP_PITCH), LEVEL(47), EXPS(F_DECAY, 108, X_CY_DECAY), DRIVE(0), DIST],
  [EXPS(F_TUNE, 64, X_SMP_PITCH), LEVEL(42), EXPS(F_DECAY, 108, X_CY_DECAY), DRIVE(0), DIST],
];

function potValue(s: Spec, pot: number): number {
  if (s.exp >= 0) return f(POT_LO[s.exp] * fmExp2f(f(POT_L2[s.exp] * f(f(pot) / 127))));
  if (s.exp === -2) return pot;
  const t = f(f(pot) / 127);
  return f(s.lo + f(f(s.hi - s.lo) * t));
}

export class Drum909 {
  bt = Array.from({ length: 5 }, () => new Bt());
  tom = [new Tom(), new Tom(), new Tom()];
  rim = new Rim();
  clap = new Clap();
  smp = [new Smp(), new Smp(), new Smp(), new Smp()];
  accent = 0;
  velDepth = 0;
  noise = new Uint32Array(1);
  nzBuf = new Float32Array(D9_NZ_BUF);
  nzPos = 0;

  constructor() {
    this.noise[0] = 0xc0ffee;
    this.nzPos = D9_NZ_HIST;
    for (let i = 0; i < 5; i++) {
      const b = this.bt[i];
      b.drive = 2; b.level = f(0.8); b.clickTone = 3000;
      switch (i) {
        case 0:
          b.tune = 13; b.sweepDepth = 0; b.pitchMod = 1; b.decay = 1380; b.ampHold = 40; b.attack = f(0.1); b.clickTone = 2500; b.drive = f(0.2); b.level = 1;
          break;
        case 1:
          b.tune = 205; b.tune2 = 325; b.osc2Mix = f(0.4); b.sweepDepth = f(1.045); b.sweepTime = 30; b.decay = 320; b.attack = f(0.15);
          b.snappy = f(0.5); b.noiseDecay = 1200; b.noiseHp = 1000; b.drive = f(1.8); b.level = f(0.62);
          break;
        case 2:
          b.tune = 68; b.sweepDepth = f(1.12); b.sweepTime = 200; b.decay = 1700; b.attack = f(0.18); b.level = f(0.55);
          break;
        case 3:
          b.tune = 102; b.sweepDepth = f(1.12); b.sweepTime = 180; b.decay = 1050; b.attack = f(0.18); b.level = f(0.55);
          break;
        default:
          b.tune = 132; b.sweepDepth = f(1.12); b.sweepTime = 160; b.decay = 1100; b.attack = f(0.18); b.level = f(0.55);
          break;
      }
      // d9_bt_init
      biquadSet(b.dcBlock, D9_HP, 20, f(0.7071));
      envSet(b.pitch, b.tune);
      envSet(b.amp, 0); envSet(b.clickEnv, 0); envSet(b.noiseEnv, 0);
      biquadSet(b.clickLp, D9_LP, b.clickTone > 0 ? b.clickTone : 3000, f(0.7071));
      biquadSet(b.noiseHpf, D9_HP, b.noiseHp > 0 ? b.noiseHp : 800, f(0.7071));
      biquadSet(b.noiseLpf, D9_LP, 6500, f(0.7071));
      if (b.pitchMod <= 0) b.pitchMod = 1;
      shapePrep(b.shape, b.drive);
    }
    for (const t of this.tom) {
      for (let j = 0; j < 3; j++) envSet(t.env[j], 0);
      envSet(t.pitch, 100);
      envSet(t.noiseEnv, 0);
      biquadSet(t.noiseBp, D9_BP, 1200, f(1.2));
      biquadSet(t.dcBlock, D9_HP, 20, f(0.7071));
    }
    const r = this.rim;
    r.tune = 210; r.tune2 = 480; r.res = 10; r.decay = 200; r.noiseMix = f(0.35); r.drive = f(1.4); r.level = f(1.1);
    biquadSet(r.bp1, D9_BP, r.tune, r.res);
    biquadSet(r.bp2, D9_BP, r.tune2, f(r.res * f(1.1)));
    biquadSet(r.hp, D9_HP, 120, f(0.7071));
    envSet(r.amp, 0);
    r.accent = 1;
    shapePrep(r.shape, r.drive);
    const c = this.clap;
    c.tune = 950; c.res = 2; c.spread = 12; c.burstDecay = 50; c.tailDecay = 345; c.tailLevel = f(0.58); c.drive = f(1.6); c.level = f(1.3);
    biquadSet(c.bp, D9_BP, c.tune, c.res);
    biquadSet(c.hp, D9_HP, 400, f(0.7071));
    envSet(c.burst, 0); envSet(c.tail, 0);
    c.pulseIndex = 4;
    c.accent = 1;
    shapePrep(c.shape, c.drive);
    const vols = [f(0.95), f(0.85), f(0.5), f(0.45)];
    const decs = [110, 450, 1800, 1800];
    for (let i = 0; i < 4; i++) {
      const s = this.smp[i];
      s.volume = vols[i]; s.decay = decs[i]; s.drive = f(0.2); s.pitch = 1; s.kind = i;
      s.noise[0] = (0x9e3779b9 + i) >>> 0;
      smpRate(s);
      envSet(s.out, 0);
      shapePrep(s.shape, s.drive);
    }
    this.accent = 2;
    this.velDepth = 1;
  }

  /** d9_apply for the fields the panel has; deferred: the shapes and filters are prepared by the caller */
  private apply(voice: number, field: number, v: number): void {
    if (voice <= D9_HT) {
      const b = this.bt[voice];
      switch (field) {
        case F_TUNE: b.tune = v; break;
        case F_ATTACK: b.attack = v; break;
        case F_DECAY: b.decay = v; break;
        case F_LEVEL: b.level = v; break;
        case F_PDEPTH: b.sweepDepth = v; break;
        case F_PITCH: b.pitchMod = v; break;
        case F_TONE: b.noiseDecay = v; break;
        case F_SNAPPY: b.snappy = v; break;
        case F_DRIVE: b.drive = v; break;
        default: break;
      }
      return;
    }
    if (voice === D9_RS) {
      const r = this.rim;
      if (field === F_TUNE) r.tune = v;
      else if (field === F_LEVEL) r.level = v;
      else if (field === F_DRIVE) r.drive = v;
      return;
    }
    if (voice === D9_CP) {
      const c = this.clap;
      if (field === F_TUNE) c.tune = v;
      else if (field === F_TAIL) c.tailDecay = v;
      else if (field === F_LEVEL) c.level = v;
      else if (field === F_DRIVE) c.drive = v;
      return;
    }
    const s = this.smp[voice - D9_CH];
    if (field === F_TUNE) s.pitch = v;
    else if (field === F_DECAY) s.decay = v;
    else if (field === F_LEVEL) s.volume = v;
    else if (field === F_DRIVE) s.drive = v;
  }

  /** d9_set_panel with the preparation deferred */
  setPanel(voice: number, i: number, value: number): void {
    const s = D9_SPECS[voice][i];
    if (value < 0) value = 0;
    if (value > s.max) value = s.max;
    this.apply(voice, s.field, potValue(s, value));
  }

  /** the voice's shaper and filters prepared from its final panel values (drum909_values) */
  prep(ins: number): void {
    if (ins <= D9_HT) shapePrep(this.bt[ins].shape, this.bt[ins].drive);
    else if (ins === D9_RS) shapePrep(this.rim.shape, this.rim.drive);
    else if (ins === D9_CP) shapePrep(this.clap.shape, this.clap.drive);
    else shapePrep(this.smp[ins - D9_CH].shape, this.smp[ins - D9_CH].drive);
  }
  rimRetune(): void { rimRetune(this.rim); }
  clapRetune(): void { clapRetune(this.clap); }
  smpRate(k: number): void { smpRate(this.smp[k]); }

  // ---------------------------------------------------------------- triggers
  private btTrigger(v: Bt, bd: boolean, accent: number): void {
    if (v.clickStale && v.mute > 0) v.clickWarm = 1;
    v.clickStale = 0;
    v.ph = v.ph2 = D9_PH_QUARTER;
    biquadReset(v.dcBlock);
    if (bd) {
      const tau = v.tune < 6 ? 6 : v.tune > 32 ? 32 : v.tune;
      const m = v.sweepDepth < 0 ? 0 : v.sweepDepth > 1 ? 1 : v.sweepDepth;
      const pm = v.pitchMod > 0 ? v.pitchMod : 1;
      v.bdBase = f(D9_BD_BASE_HZ * f(1 + f(m * f(pm - 1))));
      v.bdDf = f(f(D9_BD_DF_PER_MS * tau) * f(1 + f(f(1.2) * m)));
      v.bdMult = d9ExpSmall(f(f(-1) / f(tau * D9_MS)));
      v.bdPhold = f(D9_BD_PHOLD_MS * D9_MS) | 0;
      envSet(v.pitch, v.bdBase);
    } else {
      envSet(v.pitch, f(v.tune * v.sweepDepth));
      envExp(v.pitch, v.tune, f(v.sweepTime * D9_MS));
    }
    envSet(v.amp, 1);
    v.ampHoldLeft = f(v.ampHold * D9_MS) | 0;
    if (v.ampHoldLeft <= 0) envExp(v.amp, f(0.00001), f(v.decay * D9_MS));
    envSet(v.clickEnv, 1);
    envExp(v.clickEnv, f(0.00001), f(3 * D9_MS));
    if (v.snappy > 0) {
      envSet(v.noiseEnv, 1);
      v.noiseHold = f(24 * D9_MS) | 0;
      v.noiseGated = 0;
    }
    v.impulse = 2;
    v.outGain = f(v.level * accent);
    const longest = v.decay > v.noiseDecay ? v.decay : v.noiseDecay;
    v.mute = d9Ceil(f(f(longest + 20) * D9_MS));
  }

  private tomTrigger(t: Tom, p: Bt, accent: number): void {
    if (t.stickStale && t.mute > 0) t.stickWarm = 1;
    t.stickStale = 0;
    for (let i = 0; i < 3; i++) t.ph[i] = D9_PH_QUARTER;
    biquadReset(t.dcBlock);
    envSet(t.pitch, f(p.tune * p.sweepDepth));
    envExp(t.pitch, p.tune, f(p.sweepTime * D9_MS));
    const d1 = p.decay;
    envSet(t.env[0], 1);
    envExp(t.env[0], f(0.00001), f(d1 * D9_MS));
    envSet(t.env[1], f(0.55));
    envExp(t.env[1], f(0.00001), f(110 * D9_MS));
    envSet(t.env[2], f(0.45));
    envExp(t.env[2], f(0.00001), f(70 * D9_MS));
    t.noiseLevel = p.attack;
    envSet(t.noiseEnv, 1);
    envExp(t.noiseEnv, f(0.00001), f(8 * D9_MS));
    t.outGain = f(p.level * accent);
    t.mute = d9Ceil(f(f(d1 + 60) * D9_MS));
  }

  /** drum909_trigger: vel 0..1 */
  trigger(voice: number, vel: number): void {
    if (voice < 0 || voice >= D9_NUM) return;
    if (!(vel >= 0)) vel = 0;
    if (vel > 1) vel = 1;
    const vgain = f(this.accent * f(1 - f(this.velDepth * f(1 - vel))));
    switch (voice) {
      case D9_BD: {
        const b = this.bt[D9_BD];
        b.tune2 = 0; b.osc2Mix = 0; b.clickTone = 2500; b.ampHold = 40;
        this.btTrigger(b, true, vgain);
        break;
      }
      case D9_SD: {
        const b = this.bt[D9_SD];
        b.tune2 = f(b.tune * f(1.585));
        b.osc2Mix = f(0.4);
        b.sweepDepth = f(1.045);
        b.sweepTime = 30;
        b.decay = 340;
        b.attack = 0;
        if (b.noiseHp < 990 || b.noiseHp > 1010) {
          b.noiseHp = 1000;
          biquadSet(b.noiseHpf, D9_HP, 1000, f(0.7071));
        }
        this.btTrigger(b, false, vgain);
        break;
      }
      case D9_LT: case D9_MT: case D9_HT:
        this.tomTrigger(this.tom[voice - D9_LT], this.bt[voice], vgain);
        break;
      case D9_RS: {
        const r = this.rim;
        const t2 = f(r.tune * f(2.286)), q = 10;
        if (r.tune2 !== t2 || r.res !== q) {
          r.tune2 = t2; r.res = q;
          rimRetune(r);
        }
        r.noiseMix = f(0.35);
        r.decay = 200;
        envSet(r.amp, 1);
        envExp(r.amp, f(0.00001), f(r.decay * D9_MS));
        r.impulse = 2;
        r.accent = vgain;
        r.mute = d9Ceil(f(f(r.decay + 20) * D9_MS));
        break;
      }
      case D9_CP: {
        const c = this.clap;
        c.pulseIndex = 0;
        c.nextPulse = 0;
        envSet(c.tail, 0);
        c.accent = vgain;
        c.mute = d9Ceil(f(f(f(c.tailDecay + f(c.spread * 4)) + 40) * D9_MS));
        break;
      }
      default: {
        const s = this.smp[voice - D9_CH];
        if (voice === D9_CH || voice === D9_OH) {
          const o = this.smp[voice === D9_CH ? D9_OH - D9_CH : 0];
          envExp(o.out, f(0.00001), f(f(3 * f(0.001)) * D9_SR));
          o.mute = d9Ceil(f(f(6 * f(0.001)) * D9_SR));
        }
        envSet(s.out, f(s.volume * vgain));
        envExp(s.out, f(0.00001), f(f(s.decay * f(0.001)) * D9_SR));
        s.playing = 1;
        s.mute = d9Ceil(f(f(s.decay * f(0.001)) * D9_SR));
        break;
      }
    }
  }

  // ---------------------------------------------------------------- rendering
  /** a filter on the shared noise that stopped running is brought back by running it over the noise it missed: end = the index one past it */
  private warm(fl: Biquad, end: number): void {
    biquadReset(fl);
    for (let i = -D9_NZ_HIST; i < 0; i++) biquadTick(fl, this.nzBuf[end + i]);
  }

  /** the shared noise of this block: where it starts in nzBuf */
  noiseBlock(n: number): number {
    if (this.nzPos + n > D9_NZ_BUF) {
      for (let i = 0; i < D9_NZ_HIST; i++) this.nzBuf[i] = this.nzBuf[this.nzPos - D9_NZ_HIST + i];
      this.nzPos = D9_NZ_HIST;
    }
    const nz = this.nzPos;
    this.nzPos += n;
    for (let i = 0; i < n; i++) this.nzBuf[nz + i] = d9Noise(this.noise, 0);
    return nz;
  }

  private renderBd(v: Bt, nz: number, dry: Float32Array, n: number): void {
    const m = n < v.mute ? n : v.mute;
    v.mute -= m;
    envAnchor(v.amp);
    envAnchor(v.clickEnv);
    const attack = v.attack;
    if (v.clickWarm) {
      this.warm(v.clickLp, nz);
      v.clickWarm = 0;
    }
    for (let i = 0; i < m; i++) {
      const fr = f(v.bdBase + v.bdDf);
      if (v.bdPhold > 0) --v.bdPhold;
      else v.bdDf = f(v.bdDf * v.bdMult);
      if (v.ampHoldLeft > 0 && --v.ampHoldLeft === 0) envExp(v.amp, f(0.00001), f(f(v.decay * f(0.001)) * D9_SR));
      const amp = envTick(v.amp);
      v.ph = (v.ph + d9Inc(fr)) >>> 0;
      let o = d9Diode16(d9Tri(v.ph));
      o = f(o + f(f(f(0.05) * o) * o));
      o = biquadTick(v.dcBlock, o);
      const body = f(d9Shape(v.shape, o) * amp);
      let click = 0;
      if (v.impulse > 0 || v.clickEnv.left) {
        if (v.impulse > 0) { click = f(click + 1); v.impulse--; }
        click = f(click + biquadTick(v.clickLp, this.nzBuf[nz + i]));
        click = f(click * f(envTick(v.clickEnv) * attack));
      }
      dry[i] = f(dry[i] + f(f(body + click) * v.outGain));
    }
    if (!(v.impulse > 0 || v.clickEnv.left)) v.clickStale = 1;
    if (v.clickStale && v.mute === 0) {
      this.warm(v.clickLp, nz + m);
      v.clickStale = 0;
    }
  }

  private renderSd(v: Bt, nz: number, dry: Float32Array, n: number): void {
    const m = n < v.mute ? n : v.mute;
    v.mute -= m;
    envAnchor(v.pitch);
    envAnchor(v.amp);
    envAnchor(v.noiseEnv);
    const ratio = v.tune > 1 ? f(v.tune2 / v.tune) : 1;
    const mix2 = v.osc2Mix, invMix = f(1 / f(1 + v.osc2Mix));
    for (let i = 0; i < m; i++) {
      const fr = envTick(v.pitch);
      let amp = envTick(v.amp);
      amp = amp > D9_VCA_VT ? f(f(amp - D9_VCA_VT) * D9_VCA_NORM) : 0;
      v.ph = (v.ph + d9Inc(fr)) >>> 0;
      v.ph2 = (v.ph2 + d9Inc(f(fr * ratio))) >>> 0;
      let o = d9Diode20(d9Tri(v.ph));
      o = f(o + f(d9Diode20(d9Tri(v.ph2)) * mix2));
      o = f(o * invMix);
      let y = f(d9Shape(v.shape, o) * amp);
      if (v.snappy > 0 && !v.noiseGated) {
        if (v.noiseHold > 0 && --v.noiseHold === 0)
          envExp(v.noiseEnv, f(0.00001), f(f(f((v.noiseDecay > 0 ? v.noiseDecay : 120) * f(0.7)) * f(0.001)) * D9_SR));
        let env = envTick(v.noiseEnv);
        if (v.noiseHold <= 0) {
          env = env > D9_VCA_VT ? f(f(env - D9_VCA_VT) * D9_VCA_NORM) : 0;
          if (env <= 0) v.noiseGated = 1;
        }
        y = f(y + f(f(f(biquadTick(v.noiseLpf, biquadTick(v.noiseHpf, this.nzBuf[nz + i])) * env) * v.snappy) * D9_SNAPPY_MIX));
      }
      dry[i] = f(dry[i] + f(y * v.outGain));
    }
  }

  private renderTom(t: Tom, p: Bt, nz: number, dry: Float32Array, n: number): void {
    const m = n < t.mute ? n : t.mute;
    t.mute -= m;
    envAnchor(t.pitch);
    envAnchor(t.env[0]); envAnchor(t.env[1]); envAnchor(t.env[2]);
    envAnchor(t.noiseEnv);
    const stickG = f(t.noiseLevel * f(1.5));
    if (t.stickWarm) {
      this.warm(t.noiseBp, nz);
      t.stickWarm = 0;
    }
    for (let i = 0; i < m; i++) {
      const fr = envTick(t.pitch);
      let o = 0;
      t.ph[0] = (t.ph[0] + d9Inc(fr)) >>> 0;
      o = f(o + f(d9Diode20(d9Tri(t.ph[0])) * envTick(t.env[0])));
      if (t.env[1].left) {
        t.ph[1] = (t.ph[1] + d9Inc(f(fr * f(1.5)))) >>> 0;
        o = f(o + f(d9Diode20(d9Tri(t.ph[1])) * envTick(t.env[1])));
      }
      if (t.env[2].left) {
        t.ph[2] = (t.ph[2] + d9Inc(f(fr * f(2.75)))) >>> 0;
        o = f(o + f(d9Diode20(d9Tri(t.ph[2])) * envTick(t.env[2])));
      }
      o = f(o * f(0.55));
      let stick = 0;
      if (t.noiseEnv.left) stick = f(f(biquadTick(t.noiseBp, this.nzBuf[nz + i]) * envTick(t.noiseEnv)) * stickG);
      let y = d9Shape(p.shape, f(o + stick));
      y = biquadTick(t.dcBlock, y);
      dry[i] = f(dry[i] + f(y * t.outGain));
    }
    if (!t.noiseEnv.left) t.stickStale = 1;
    if (t.stickStale && t.mute === 0) {
      this.warm(t.noiseBp, nz + m);
      t.stickStale = 0;
    }
  }

  private renderRim(v: Rim, nz: number, dry: Float32Array, n: number): void {
    const m = n < v.mute ? n : v.mute;
    v.mute -= m;
    envAnchor(v.amp);
    const g = v.level;
    for (let i = 0; i < m; i++) {
      let exc = 0;
      if (v.impulse > 0) {
        exc = f(exc + f(1 + f(this.nzBuf[nz + i] * v.noiseMix)));
        v.impulse--;
      }
      const a = envTick(v.amp);
      let y = f(f(biquadTick(v.bp1, exc) * 60) + f(biquadTick(v.bp2, exc) * 32));
      y = d9Shape(v.shape, f(y * a));
      y = biquadTick(v.hp, y);
      dry[i] = f(dry[i] + f(f(y * g) * v.accent));
    }
  }

  private renderClap(v: Clap, nz: number, dry: Float32Array, n: number): void {
    const AMP = [f(1.22), f(1.35), f(1.68), 1];
    const m = n < v.mute ? n : v.mute;
    v.mute -= m;
    envAnchor(v.burst);
    envAnchor(v.tail);
    for (let i = 0; i < m; i++) {
      if (v.pulseIndex < 4) {
        if (v.nextPulse <= 0) {
          envSet(v.burst, AMP[v.pulseIndex]);
          envExp(v.burst, f(0.00001), f(v.burstDecay * D9_MS));
          if (v.pulseIndex === 3) {
            envSet(v.tail, v.tailLevel);
            envExp(v.tail, f(0.00001), f(v.tailDecay * D9_MS));
          }
          v.pulseIndex++;
          v.nextPulse = f(v.spread * D9_MS);
        }
        v.nextPulse = f(v.nextPulse - 1);
      }
      const env = f(envTick(v.burst) + envTick(v.tail));
      let y = f(biquadTick(v.bp, this.nzBuf[nz + i]) * env);
      y = d9Shape(v.shape, y);
      y = biquadTick(v.hp, y);
      dry[i] = f(dry[i] + f(f(y * v.level) * v.accent));
    }
  }

  private renderSmp(s: Smp, dry: Float32Array, n: number): void {
    const HZ = [f(205.3), f(304.4), f(369.6), f(522.7), f(540), f(800)];
    const m = n < s.mute ? n : s.mute;
    const inc = new Uint32Array(6);
    for (let k = 0; k < 6; k++) inc[k] = d9Inc(f(f(HZ[k] * s.pitch) * (s.kind === 3 ? f(1.48) : 1)));
    s.mute -= m;
    envAnchor(s.out);
    for (let i = 0; i < m; i++) {
      let metal = 0;
      for (let k = 0; k < 6; k++) {
        s.ph[k] += inc[k];
        metal = f(metal + (s.ph[k] & 0x80000000 ? f(0.16) : -f(0.16)));
      }
      const nzv = d9Noise(s.noise, 0);
      const exc = s.kind === 2 ? f(f(metal * f(0.6)) + f(nzv * f(0.4))) : metal;
      let y = biquadTick(s.hp, biquadTick(s.bp, exc));
      y = f(d9Shape(s.shape, f(y * 2)) * envTick(s.out));
      dry[i] = f(dry[i] + y);
    }
    if (!s.mute) s.playing = 0;
  }

  /** one voice's block into dry (n floats, zeroed by the caller) */
  renderVoice(voice: number, nz: number, dry: Float32Array, n: number): void {
    switch (voice) {
      case D9_BD: this.renderBd(this.bt[0], nz, dry, n); break;
      case D9_SD: this.renderSd(this.bt[1], nz, dry, n); break;
      case D9_LT: case D9_MT: case D9_HT: this.renderTom(this.tom[voice - D9_LT], this.bt[voice], nz, dry, n); break;
      case D9_RS: this.renderRim(this.rim, nz, dry, n); break;
      case D9_CP: this.renderClap(this.clap, nz, dry, n); break;
      default: if (voice >= D9_CH && voice <= D9_RD) this.renderSmp(this.smp[voice - D9_CH], dry, n); break;
    }
  }

  /** drum909_live: the voice still sounds */
  live(ins: number): boolean {
    if (ins <= D9_SD) return this.bt[ins].mute > 0;
    if (ins <= D9_HT) return this.tom[ins - D9_LT].mute > 0;
    if (ins === D9_RS) return this.rim.mute > 0;
    if (ins === D9_CP) return this.clap.mute > 0;
    return this.smp[ins - D9_CH].mute > 0;
  }
}
export { fmClampf };
