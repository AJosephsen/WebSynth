// Port of Melodee's drum_lanes.c, drum_cr78.c and drum_fm.c (GPL-3.0-only, Copyright (C) 2026 Kerem Kilic): KIT CR78, a late-1970s
// preset rhythm box after the CompuRhythm CR-78's voice list built from the 808's circuit pieces, and KIT FM, two-operator FM
// drums, on eight lanes with eased retriggers, hat choke and recorded lengths. The CR78 values are designed after the
// box's sound, not measured from a unit (the C source says so). C int32 arithmetic uses Math.imul / >> / | 0. See NOTICE.
import { clamp, mulq15, sineI, softclip } from "../engines/dsp";
import { CTL } from "../engines/types";
import { D9_BD, D9_CH, D9_OH, D9_SD } from "./m909";
import { fmClampf, fmExp2f, fmTanf, FM_PI } from "./fastmath";
import {
  CTL_LOG2, DR_LIFE, DR_PEND, DR_QUIET, DR_DUTY, DRE_LOW, DRS, Dre, Drf, Dither, dr8Level, drBlk, drDamp, drF, drLp1, drMs, drPow2, drPulse, drRes,
  drTau, drTuned, drfBp, drfHp, dreAt, dreNext, int16, mulShr, noise32, voiceAmpD,
} from "./mdsp";
import { softKneeI } from "./mdsp";

const f = Math.fround;
export const DLK_EASE = 5, DLK_FADE = 128, DLK_HIT_V = 1742, DLK_NONE = 0, DLK_HP = 1, DLK_BP = 2, DLK_GAP = 441;
export const DV_NLANE = 8;

export class DlkCh {
  t = 0; v = 0; gain = 0; g = 0; left = 0; fade = 0; last = 0; ease = 0;
  px = new Int32Array(1);
  f = new Int32Array(2); q = new Int32Array(2); lp = new Int32Array(2); bp = new Int32Array(2);
  ph = new Uint32Array(2); inc = new Uint32Array(2);
  k = new Int32Array(2);
  m1 = 0; m2 = 0;
  ng = 0; rise = 0; rstep = 0; burst = 0;
  tk = 0; ts = 0;
  e = [new Dre(), new Dre(), new Dre(), new Dre()];
  nf: Drf = { a1: 0, a2: 0, a3: 0, k: 0 };
  sf: Drf = { a1: 0, a2: 0, a3: 0, k: 0 };
  ns = new Int32Array(2); ss = new Int32Array(2);
  nst = new Int32Array(1);
  sound = 0; rec = 0; on = 0; level = 0;
}

/** a state-variable filter's coefficients at hz with quality qf */
function dlkSvf(hz: number, qf: number): Drf {
  const g = fmTanf(f(f(FM_PI * fmClampf(hz, 20, f(f(0.45) * 44100))) / 44100));
  const k = f(1 / qf);
  const a1 = f(1 / f(1 + f(g * f(g + k))));
  return { a1: int16(f(a1 * 8192) | 0), a2: int16(f(f(g * a1) * 8192) | 0), a3: int16(f(f(f(g * g) * a1) * 8192) | 0), k: int16(f(k * 8192) | 0) };
}
/** from the top, -40 dB after ms (x 2 a DECY of 24) */
function dlkSet(e: Dre, ms: number, dec: number): void {
  e.e = 1 << 24;
  e.k = drBlk(Math.floor((drTau(ms) * drPow2(dec * 8)) / 65536) >>> 0);
}
function dlkNoiseSet(c: DlkCh, type: number, hz: number, qf: number, ms: number, rise: number, bursts: number, dec: number, level: number): void {
  c.nf = dlkSvf(hz, type === DLK_BP ? qf : f(0.71));
  dlkSet(c.e[0], ms, dec);
  c.ng = level;
  c.rstep = rise ? Math.trunc(32767 / drMs(rise)) + 1 : 32767;
  c.rise = rise || bursts ? 0 : 32767;
  c.burst = 0;
}
/** the drum's noise, one block into y; 0 once it is over */
function dlkNoise(c: DlkCh, y: Int32Array, n: number, type: number, bursts: number): boolean {
  const de = dreNext(c.e[0]);
  const e0 = DRS[0];
  const more = Math.imul((bursts - 1) | 0, DLK_GAP);
  const t0 = c.t;
  for (let i = 0; i < n; i++) {
    const nz = (noise32(c.nst, 0) >>> 17) - 16384;
    let w = dreAt(e0, de, i);
    if (bursts) {
      const last = c.burst > more;
      if (!last && ((t0 + i) >>> 0) === (c.burst >>> 0)) {
        c.rise = 32767;
        c.burst += DLK_GAP;
      }
      c.rise -= (c.rise >> (last ? 8 : 7)) + (c.rise > 0 ? 1 : 0);
      w = c.rise + (Math.imul(w, 9000) >> 15);
    } else {
      if (c.rise < 32767) c.rise = c.rise + c.rstep > 32767 ? 32767 : c.rise + c.rstep;
      w = Math.imul(w, c.rise) >> 15;
    }
    const fo = type === DLK_BP ? drfBp(c.nf, nz, c.ns, 0) : drfHp(c.nf, nz, c.ns, 0);
    y[i] += Math.imul(Math.imul(fo, w) >> 15, c.ng) >> 12;
  }
  return c.e[0].e >= DRE_LOW || (bursts !== 0 && (c.rise > 8 || c.burst <= more));
}

// ------------------------------------------------------------------ KIT CR78
const CR_METAL = 16;
interface CrSound {
  hz: number[]; ms: number[]; g: number[]; drop: number; nf: number; nhz: number; nq: number; nms: number; nrise: number; dk: number; ng: number;
  sq: number[]; shz: number; sms: number; sg: number; lp: number; out: number;
}
const cs = (hz: number[], ms: number[], g: number[], drop: number, nf: number, nhz: number, nq: number, nms: number, nrise: number, dk: number, ng: number,
  sq: number[], shz: number, sms: number, sg: number, lp: number, out: number): CrSound => ({ hz, ms, g, drop, nf, nhz, nq, nms, nrise, dk, ng, sq, shz, sms, sg, lp, out });
const Z2 = [0, 0];
const CR_SOUNDS: CrSound[] = [
  cs([62, 0], [260, 0], [7200, 0], 0, DLK_NONE, 0, 0, 0, 0, 1, 0, Z2, 0, 0, 0, 900, 4096), // KICK
  cs([190, 330], [70, 40], [2800, 3000], 0, DLK_HP, 1800, 71, 170, 0, 0, 2600, Z2, 0, 0, 0, 12000, 4518), // SNARE
  cs([120, 0], [240, 0], [5500, 0], 8, DLK_NONE, 0, 0, 0, 0, 0, 0, Z2, 0, 0, 0, 3000, 4253), // TOM L, M, H
  cs([165, 0], [200, 0], [5500, 0], 8, DLK_NONE, 0, 0, 0, 0, 0, 0, Z2, 0, 0, 0, 3500, 4369),
  cs([225, 0], [170, 0], [5500, 0], 8, DLK_NONE, 0, 0, 0, 0, 0, 0, Z2, 0, 0, 0, 4000, 4303),
  cs([520, 1650], [18, 10], [27000, 43000], 0, DLK_NONE, 0, 0, 0, 0, 0, 0, Z2, 0, 0, 0, 12000, 1341), // RIM
  cs(Z2, Z2, Z2, 0, DLK_BP, 7500, 150, 220, 2, 0, 2200, [5100, 7300], 6500, 180, 900, 16000, 5589), // TAMB
  cs(Z2, Z2, Z2, 0, DLK_HP, 7000, 71, 45, 0, 0, 3000, Z2, 0, 0, 0, 16000, 7524), // HAT C, HAT O
  cs(Z2, Z2, Z2, 0, DLK_HP, 7000, 71, 320, 0, 1, 3000, Z2, 0, 0, 0, 16000, 6595),
  cs(Z2, Z2, Z2, 0, DLK_BP, 8500, 90, 1100, 0, 1, 2600, Z2, 0, 0, 0, 16000, 7510), // CYMB
  cs(Z2, Z2, Z2, 0, DLK_NONE, 0, 0, 0, 0, 0, 0, [587, 845], 900, 220, 2600, 8000, 3422), // BELL
  cs([200, 0], [150, 0], [8800, 0], 4, DLK_NONE, 0, 0, 0, 0, 0, 0, Z2, 0, 0, 0, 5000, 2581), // CONGA, BONGO L, BONGO H
  cs([300, 0], [90, 0], [12000, 0], 0, DLK_NONE, 0, 0, 0, 0, 0, 0, Z2, 0, 0, 0, 6000, 1839),
  cs([420, 0], [70, 0], [16800, 0], 0, DLK_NONE, 0, 0, 0, 0, 0, 0, Z2, 0, 0, 0, 7000, 1615),
  cs([2450, 0], [35, 0], [12250, 0], 0, DLK_NONE, 0, 0, 0, 0, 0, 0, Z2, 0, 0, 0, 16000, 3519), // CLAVE
  cs(Z2, Z2, Z2, 0, DLK_HP, 6000, 71, 70, 12, 0, 8940, Z2, 0, 0, 0, 16000, 4096), // MARAC
  cs(Z2, Z2, Z2, 0, DLK_HP, 9000, 71, 30, 0, 0, 700, [1190, 1771], 3600, 60, 2600, 16000, 5627), // METAL BEAT short, long
  cs(Z2, Z2, Z2, 0, DLK_HP, 9000, 71, 200, 0, 1, 600, [1190, 1771], 3600, 300, 2400, 16000, 5045),
];

/** the trigger pulse through the 808's pulse shaper */
const crPulse = (c: DlkCh, t: number): number => drPulse(t, c.v, c.px, 0);

/** the lane struck: its drum's recipe at the hit's pitch and the knobs; warm: the same drum rings, struck again. Returns 1 from rest */
export function crHit(c: DlkCh, sound: number, tune: number, q: ArrayLike<number>, dk: number, warm: boolean): number {
  const rec = (sound === D9_CH || sound === D9_OH) && q[6] ? CR_METAL + (sound === D9_OH ? 1 : 0) : sound;
  const s = CR_SOUNDS[rec];
  const dec = dk + (s.dk ? q[3] - 64 : 0);
  const r = fmExp2f(f(f(tune) / 192));
  const lp = f(f(s.lp) * fmExp2f(f(f(q[2] - 64) / 21)));
  warm = warm && c.rec === rec;
  if (!warm) {
    c.px[0] = c.lp[0] = c.bp[0] = c.lp[1] = c.bp[1] = 0;
    c.ns[0] = c.ns[1] = c.ss[0] = c.ss[1] = c.ts = 0;
  }
  c.rec = rec;
  c.gain = Math.floor((c.gain * s.out) / 4096) | 0;
  for (let k = 0; k < 2; k++)
    if (s.hz[k]) {
      c.f[k] = drTuned(drF(s.hz[k]), tune);
      c.q[k] = drDamp(c.f[k], Math.floor((drTau(s.ms[k]) * drPow2(dec * 8)) / 65536) >>> 0);
      c.k[k] = Math.floor((Math.trunc((s.g[k] * 100) / s.hz[k]) * drPow2(-tune)) / 65536) | 0;
    }
  dlkSet(c.e[1], Math.floor(s.ms[0] / 2) + 1, dec);
  if (s.nf) dlkNoiseSet(c, s.nf, f(f(s.nhz) * r), f(f(s.nq) / 100), s.nms, s.nrise, 0, dec, sound === D9_SD ? Math.trunc((s.ng * q[4]) / 64) : s.ng);
  if (s.sq[0]) {
    c.sf = dlkSvf(f(f(s.shz) * r), 3);
    dlkSet(c.e[2], s.sms, dec);
    for (let k = 0; k < 2; k++) c.inc[k] = Math.trunc(f(f(f(s.sq[k]) * r) * f(97391.55))) >>> 0;
  }
  c.tk = lp >= 16000 ? 16384 : clamp(drLp1(Math.trunc(fmClampf(lp, 40, f(15999)))), 1, 16384);
  return warm ? 0 : 1;
}

/** the lane's drum, one block into y; false once it has rung out */
function crRun(c: DlkCh, y: Int32Array, n: number): boolean {
  const s = CR_SOUNDS[c.rec];
  const t0 = c.t;
  let live = t0 < DR_PEND;
  if (s.hz[0]) {
    let f0 = c.f[0];
    let pk = 0;
    dreNext(c.e[1]);
    const d0 = DRS[0];
    if (s.drop) f0 = (f0 + (mulShr(f0, Math.trunc(((d0 >> 9) * s.drop) / 100), 15) | 0)) | 0;
    for (let i = 0; i < n; i++) {
      const x = t0 + i < DR_PEND ? Math.imul(crPulse(c, t0 + i), 16) : 0;
      let r = mulShr(drRes(c.lp, 0, c.bp, 0, f0, c.q[0], x), c.k[0], 16) | 0;
      if (s.hz[1]) r = (r + (mulShr(drRes(c.lp, 1, c.bp, 1, c.f[1], c.q[1], x), c.k[1], 16) | 0)) | 0;
      r = clamp(r, -65535, 65535);
      y[i] += r;
      pk = r > pk ? r : -r > pk ? -r : pk;
    }
    live = live || pk >= DR_QUIET;
  }
  if (s.nf) live = dlkNoise(c, y, n, s.nf, 0) || live;
  if (s.sq[0]) {
    const de = dreNext(c.e[2]);
    const e0 = DRS[0];
    for (let i = 0; i < n; i++) {
      const x = (c.ph[0] < DR_DUTY ? 8192 : -8192) + (c.ph[1] < DR_DUTY ? 8192 : -8192);
      c.ph[0] += c.inc[0];
      c.ph[1] += c.inc[1];
      y[i] += Math.imul(Math.imul(drfBp(c.sf, x, c.ss, 0), dreAt(e0, de, i)) >> 15, s.sg) >> 12;
    }
    live = live || c.e[2].e >= DRE_LOW;
  }
  if (c.tk < 16384)
    for (let i = 0; i < n; i++) {
      c.ts = (c.ts + (mulShr(y[i] - c.ts, c.tk, 14) | 0)) | 0;
      y[i] = c.ts;
    }
  return live && t0 < DR_LIFE;
}

// ------------------------------------------------------------------ KIT FM
const FMK_PHASE = 20861, FMK_FB = 1300;
interface FmSound {
  hz: number; ratio: number; index: number; fb: number; cms: number; ims: number; sweep: number; sms: number; nf: number; bursts: number;
  nhz: number; nms: number; nrise: number; dk: number; ng: number; g: number; hp: number; out: number;
}
const R = (x: number): number => Math.trunc(x * 256 + 0.5) & 0xffff;
const fs = (hz: number, ratio: number, index: number, fb: number, cms: number, ims: number, sweep: number, sms: number, nf: number, bursts: number,
  nhz: number, nms: number, nrise: number, dk: number, ng: number, g: number, hp: number, out: number): FmSound =>
  ({ hz, ratio, index, fb, cms, ims, sweep, sms, nf, bursts, nhz, nms, nrise, dk, ng, g, hp, out });
const FMK_SOUNDS: FmSound[] = [
  fs(52, R(1.0), 24, 0, 450, 25, 24, 45, DLK_NONE, 0, 0, 0, 0, 1, 0, 4096, 0, 4096), // KICK
  fs(185, R(1.56), 32, 0, 140, 40, 7, 25, DLK_HP, 0, 1500, 180, 0, 0, 2400, 2600, 0, 3642), // SNARE
  fs(95, R(1.0), 19, 0, 380, 60, 7, 120, DLK_NONE, 0, 0, 0, 0, 0, 0, 3600, 0, 3684), // TOM L, M, H
  fs(130, R(1.0), 19, 0, 320, 60, 7, 110, DLK_NONE, 0, 0, 0, 0, 0, 0, 3600, 0, 3656),
  fs(175, R(1.0), 19, 0, 270, 60, 7, 100, DLK_NONE, 0, 0, 0, 0, 0, 0, 3600, 0, 3640),
  fs(460, R(3.46), 40, 0, 30, 12, 0, 0, DLK_NONE, 0, 0, 0, 0, 0, 0, 3600, 0, 3165), // RIM
  fs(0, 0, 0, 0, 0, 0, 0, 0, DLK_BP, 4, 1200, 160, 0, 0, 10190, 0, 0, 4096), // CLAP
  fs(3020, R(1.414), 128, 5, 45, 45, 0, 0, DLK_NONE, 0, 0, 0, 0, 0, 0, 3000, 6000, 3310), // HAT C, HAT O
  fs(3020, R(1.414), 128, 5, 350, 300, 0, 0, DLK_NONE, 0, 0, 0, 0, 1, 0, 2600, 6000, 3022),
  fs(2100, R(2.31), 160, 6, 1300, 900, 0, 0, DLK_HP, 0, 7000, 1000, 0, 1, 500, 2400, 4000, 2830), // CYMB
  fs(830, R(3.5), 48, 0, 900, 500, 0, 0, DLK_NONE, 0, 0, 0, 0, 1, 0, 2600, 0, 4316), // BELL
  fs(210, R(1.0), 16, 0, 200, 25, 3, 30, DLK_NONE, 0, 0, 0, 0, 0, 0, 3600, 0, 3315), // CONGA L, M, H
  fs(300, R(1.0), 16, 0, 170, 25, 3, 30, DLK_NONE, 0, 0, 0, 0, 0, 0, 3600, 0, 3285),
  fs(420, R(1.0), 16, 0, 140, 25, 3, 30, DLK_NONE, 0, 0, 0, 0, 0, 0, 3600, 0, 3277),
  fs(2450, R(1.0), 10, 0, 40, 10, 0, 0, DLK_NONE, 0, 0, 0, 0, 0, 0, 3000, 0, 3375), // CLAVE
  fs(0, 0, 0, 0, 0, 0, 0, 0, DLK_HP, 0, 7000, 60, 8, 0, 8010, 0, 0, 4096), // MARAC
];

/** the lane struck: its drum at the hit's pitch and the knobs; always from rest: 1 */
export function fmkHit(c: DlkCh, sound: number, tune: number, q: ArrayLike<number>, dk: number): number {
  const s = FMK_SOUNDS[sound];
  const dec = dk + (s.dk ? q[3] - 64 : 0);
  const round = sound === D9_BD && q[6] !== 0;
  const r = fmExp2f(f(f(tune) / 192));
  const tone = fmExp2f(f(f(q[2] - 64) / 32));
  c.rec = sound;
  c.gain = Math.floor((c.gain * s.out) / 4096) | 0;
  c.ph[0] = c.ph[1] = 0;
  c.m1 = c.m2 = 0;
  c.ns[0] = c.ns[1] = c.ss[0] = c.ss[1] = 0;
  c.inc[0] = Math.trunc(f(f(f(s.hz) * r) * f(97391.55))) >>> 0;
  c.inc[1] = Math.floor((c.inc[0] * s.ratio) / 256) >>> 0;
  let ki = f(f(s.index) / 16);
  ki = f(ki * f(FMK_PHASE));
  ki = f(ki * tone);
  ki = f(ki * (round ? f(0.4) : 1));
  c.k[0] = ki | 0;
  const sw = f(round ? Math.floor(s.sweep / 2) : s.sweep);
  c.k[1] = f(f(fmExp2f(f(sw / 12)) - 1) * 65536) | 0;
  dlkSet(c.e[1], s.cms, dec);
  dlkSet(c.e[2], s.ims, dec);
  dlkSet(c.e[3], s.sms ? s.sms : 1, 0);
  if (s.nf) dlkNoiseSet(c, s.nf, f(f(s.nhz) * r), f(1.5), s.nms, s.nrise, s.bursts, dec, sound === D9_SD ? Math.trunc((s.ng * q[4]) / 64) : s.ng);
  if (s.hp) c.sf = dlkSvf(f(f(s.hp) * r), f(0.71));
  return 1;
}

function fmkRun(c: DlkCh, y: Int32Array, n: number): boolean {
  const s = FMK_SOUNDS[c.rec];
  let live = false;
  if (s.hz) {
    const da = dreNext(c.e[1]);
    const a0 = DRS[0];
    const di = dreNext(c.e[2]);
    const i0 = DRS[0];
    const fbk = s.fb * FMK_FB;
    dreNext(c.e[3]);
    const p0 = DRS[0];
    const sw = (65536 + Math.floor((c.k[1] * p0) / 16777216)) >>> 0;
    const ic = Math.floor((c.inc[0] * sw) / 65536) >>> 0;
    const im = Math.floor((c.inc[1] * sw) / 65536) >>> 0;
    const ka = Math.floor((c.k[0] * i0) / 16777216) | 0;
    const kb = Math.floor((c.k[0] * ((i0 + di) | 0)) / 16777216) | 0;
    for (let i = 0; i < n; i++) {
      const m = sineI((c.ph[1] + Math.imul(c.m1 + c.m2, fbk)) >>> 0);
      c.m2 = c.m1;
      c.m1 = m;
      c.ph[1] += im;
      const o = sineI((c.ph[0] + (m * (ka + (Math.imul(kb - ka, i) >> CTL_LOG2)) | 0)) >>> 0);
      c.ph[0] += ic;
      y[i] += Math.imul(Math.imul(o, dreAt(a0, da, i)) >> 15, s.g) >> 12;
    }
    live = c.e[1].e >= DRE_LOW;
  }
  if (s.nf) live = dlkNoise(c, y, n, s.nf, s.bursts) || live;
  if (s.hp) for (let i = 0; i < n; i++) y[i] = drfHp(c.sf, y[i], c.ss, 0);
  return live && c.t < DR_LIFE;
}

// ------------------------------------------------------------------ the lanes
/** a lane level (P_LN0..) and a drum's LEVEL as one gain (Q15) */
export function dskLevel(ln: ArrayLike<number>, lane: number, level: number): number {
  const lv = Math.trunc((clamp(ln[lane & (DV_NLANE - 1)], 0, 127) * level) / 127);
  return Math.trunc(Math.imul(Math.imul(lv, lv), 32767) / (127 * 127));
}

/** a part's lanes of one lane kit (dlk_part_t): kit = DK_CR78 or DK_FM */
export class DlkPart {
  ch: DlkCh[] = Array.from({ length: DV_NLANE }, (_, k) => {
    const c = new DlkCh();
    c.nst[0] = (0x2f6e2b1 + Math.imul(k, 0x9e3779b9)) | 0;
    return c;
  });
  constructor(readonly cr78: boolean) {}

  /** dlk_hit: a hit on a lane's drum (sound), st: semitones from its designed pitch (GM map), pc: the HIT page's four edits of the sound */
  hit(lane: number, sound: number, vel: number, st: number, pc: ArrayLike<number>, p: ArrayLike<number>, eventPitch: number, eventLength: number): void {
    const c = this.ch[lane];
    if (lane === 3 && this.ch[4].on && !this.ch[4].fade) this.ch[4].fade = DLK_FADE;
    const q = [p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7]];
    if (sound === D9_SD) q[4] = clamp(q[4] + pc[2], 0, 127);
    else q[2] = clamp(q[2] + pc[2], 0, 127);
    const tune = clamp((st + pc[0] + eventPitch) * 16 + (q[1] - 64) * 3, -576, 576);
    c.gain = dr8Level(vel, q[5]);
    c.level = 127 - pc[3];
    c.left = eventLength;
    c.v = vel * DLK_HIT_V;
    if (this.cr78 ? crHit(c, sound, tune, q, pc[1], c.on !== 0 && !c.fade && c.sound === sound) : fmkHit(c, sound, tune, q, pc[1])) {
      c.ease = c.last;
      c.g = -1;
    }
    c.fade = 0;
    c.sound = sound;
    c.t = 0;
    c.on = 1;
  }

  /** once per control tick (drum_amp): false once every lane has gone quiet */
  tick(): boolean {
    for (const c of this.ch) if (c.on || c.ease) return true;
    return false;
  }

  /** the kit, one block: each lane's drum at its level, the steps easing out, DRV, the output as the 808's. The result is added to out. */
  render(out: Int32Array, n: number, amp0: number, amp1: number, p: ArrayLike<number>, ln: ArrayLike<number>, dith: Int16Array): void {
    const y = new Int32Array(CTL), x = new Int32Array(CTL);
    const drv = p[7];
    let g = 0, mk = 0;
    for (let k = 0; k < DV_NLANE; k++) {
      const c = this.ch[k];
      let s = 0;
      if (!c.on && !c.ease) continue;
      x.fill(0, 0, n);
      if (c.on && !(this.cr78 ? crRun(c, x, n) : fmkRun(c, x, n))) c.on = 0;
      c.t += n;
      if (c.on && c.left > 0 && (c.left -= n) <= 0 && !c.fade) c.fade = DLK_FADE;
      const g1 = mulq15(c.gain, dskLevel(ln, k, c.level));
      const g0 = c.g < 0 ? g1 : c.g;
      c.g = g1;
      for (let i = 0; i < n; i++) {
        s = Math.floor((x[i] * (g0 + (Math.imul(g1 - g0, i) >> CTL_LOG2))) / 32768) | 0;
        if (c.fade) s = c.fade > i ? Math.trunc(Math.imul(s, c.fade - i) / DLK_FADE) : 0;
        s = (s + c.ease) | 0;
        c.ease -= c.ease >> DLK_EASE;
        y[i] += s;
      }
      if (c.ease > -(1 << DLK_EASE) && c.ease < 1 << DLK_EASE) c.ease = 0;
      if (c.fade && (c.fade -= n) <= 0) {
        c.fade = 0;
        c.on = 0;
      }
      c.last = c.on || c.ease ? s : 0;
    }
    if (drv > 0) {
      g = 4096 + Math.trunc((drv * 3 * 4096) / 127);
      mk = Math.floor((19661 * 32768) / softclip((19661 * g) >> 12)) | 0;
    }
    for (let i = 0; i < n; i++) {
      let s = clamp(y[i], -131071, 131071);
      if (g) s = Math.imul(softclip(Math.imul(s, g) >> 12), mk) >> 15;
      out[i] += voiceAmpD(softKneeI((s + (s >> 2)) | 0, 24000), amp0, amp1, i, dith) << 1;
    }
  }
}
export type { Dither };
