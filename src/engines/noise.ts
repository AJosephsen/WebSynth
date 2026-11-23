// Port of Felucca-Engines' eng_noise.c (MIT): noise from analog-style to shift-register, through a resonant filter.
// See NOTICE.
import { clamp, mulq15, noiseStep, pitchInc, softKnee, voiceAmp } from "./dsp";
import { SVF_G } from "./tables";
import { EngineDef, EngVoice, F, FS, P_E0, P_E1, P_E2, P_E3, P_E4, P_E5, P_E6, P_E7, P_REL, ParamDesc, Track, Vmod } from "./types";

const N_MODE = ["ANLG", "DUST", "LFSR", "META"];
const NZ_ANLG = 0, NZ_DUST = 1, NZ_LFSR = 2, NZ_META = 3;
const N_LONG = ["L23", "L20", "L17", "L15", "L13", "L11", "L9", "L7"];
const N_META = ["127", "127B", "93", "63", "63B", "31", "15", "7"];
const LONG: ParamDesc = { label: "LEN", fmt: F.INT, min: 0, max: 127, def: 0, names: N_LONG };
const META: ParamDesc = { label: "LEN", fmt: F.INT, min: 0, max: 127, def: 0, names: N_META };
const CLK: ParamDesc = { label: "CLK", fmt: F.INT, min: 0, max: 127, def: 0, unit: "st" };
const TAPS = [0x420000, 0x90000, (1 << 16) | (1 << 13), 0x6000, 0x100d, 0x500, 0x110, 0x60];
const SEQ: { w: number[]; len: number; hi: number; lo: number }[] = [
  { w: [0xd13c50c1, 0x91c2f95c, 0xa58ded6c, 0x01fd533b], len: 127, hi: 16128, lo: -16384 },
  { w: [0xdbd165f1, 0x9e46a1fd, 0x84c15692, 0x019b1ceb], len: 127, hi: 16128, lo: -16384 },
  { w: [0x41008001, 0x00492402, 0x00824824, 0x00000000], len: 93, hi: 16384, lo: -3404 },
  { w: [0x27179461, 0x03f566ed, 0, 0], len: 63, hi: 15872, lo: -16384 },
  { w: [0x75a6c487, 0x02fca8cf, 0, 0], len: 63, hi: 15872, lo: -16384 },
  { w: [0x05763e69, 0, 0, 0], len: 31, hi: 15360, lo: -16384 },
  { w: [0x00000f59, 0, 0, 0], len: 15, hi: 14336, lo: -16384 },
  { w: [0x0000001d, 0, 0, 0], len: 7, hi: 12288, lo: -16384 },
];
const THR_K = Math.floor(2 ** 32 / FS);
const PINK0_P = 32690, PINK0_G = 3245, PINK1_P = 31555, PINK1_G = 9716, PINK2_P = 18678, PINK2_G = 17247, BROWN_P = 32580, BROWN_G = 3480;

/** Phase increment of pitch p (1/16 semitone) past the table's top, up to one step a sample. */
function noiseInc(p: number): number {
  let sh = 0;
  while (p > 2047) { p -= 192; sh++; }
  const inc = pitchInc(clamp(p, 0, 2047));
  return sh && inc >= 0x80000000 >>> (sh - 1) ? 0xffffffff : (inc << sh) >>> 0;
}

function isqrt32(x: number): number {
  let r = 0;
  let b = 1 << 30;
  while (b > x) b >>>= 2;
  while (b) {
    if (x >= r + b) {
      x -= r + b;
      r = (r >>> 1) + b;
    } else {
      r >>>= 1;
    }
    b >>>= 2;
  }
  return r;
}

function noteOn(_t: Track, v: EngVoice): void {
  const seed = (Math.imul(v.note + 1, 0x9e3779b9) ^ Math.imul(v.fine, 0x85ebca6b)) >>> 0;
  v.s[0] = v.s[1] = 0;
  v.s[2] = seed ? seed | 0 : 1;
  v.s[3] = 0;
  v.s[4] = v.s[5] = v.s[6] = v.s[7] = 0;
  v.ph[0] = 0;
  v.ph[1] = 0;
  v.ph[2] = 0;
}

function render(t: Track, v: EngVoice, out: Int32Array, n: number, m: Vmod): void {
  const p = t.p;
  const mode = p[P_E0] & 3;
  const sel = (p[P_E5] >> 4) & 7;
  const res = p[P_E3], drft = p[P_E6];
  const crsh = mode < NZ_LFSR ? p[P_E7] : 0;
  let ic1 = v.s[0], ic2 = v.s[1], rng = v.s[2], b0 = v.s[4], b1 = v.s[5], b2 = v.s[6], br = v.s[7];
  let ph = v.ph[0], reg = v.ph[1];
  let drift = v.ph[2] | 0;
  let d16 = 0, gain = 32767, thr = 0;
  let inc = 0;
  const taps = TAPS[sel];
  if (drft) {
    let tg = v.s[3] >> 16;
    let cnt = v.s[3] & 0xffff;
    if (--cnt <= 0) {
      rng = noiseStep(rng);
      const r = rng >>> 0;
      tg = (r >>> 16) - 32768;
      cnt = 1024 + (r & 3071);
    }
    v.s[3] = ((tg << 16) | cnt) | 0;
    drift += ((tg << 4) - drift) >> 10;
    d16 = (Math.imul((drift >> 11) * drft, drft)) >> 14;
    gain = 32767 - ((Math.imul((32767 - (drift >> 4)) >> 1, drft)) >> 8);
  }
  const colr = clamp((p[P_E1] << 8) + m.shape - (64 << 8), 0, 127 << 8);
  const cf = colr <= 64 << 8 ? colr << 1 : ((colr - (64 << 8)) * 520) >> 8;
  let cut = (p[P_E2] << 8) + m.cutoff + (((m.pitch16 - 60 * 16) * p[P_E4] * 151) >> 10) + ((d16 * 4785) >> 8);
  cut = clamp(cut, 0, 127 << 8);
  let g = SVF_G[cut >> 8];
  if (cut < 127 << 8) g += Math.imul(SVF_G[(cut >> 8) + 1] - g, cut & 255) >> 8;
  const k = 8192 - Math.trunc((res * 7800) / 127);
  const a1 = Math.floor((4096 * 8192) / (4096 + (Math.imul(g, g + k) >> 12)));
  const a2 = Math.imul(a1, g) >> 12;
  const a3 = Math.imul(a2, g) >> 12;
  const bpg = isqrt32((k << 12) >>> 0);
  const mix = res * 258;
  let gq: number;
  {
    const wf = 32767 - ((colr * 230) >> 8);
    let mk = (((((127 << 8) - cut) >> 8) * 7) * wf) >> 15;
    mk += 214 + (mode === NZ_DUST ? 512 : 0);
    if (mk > 1279) mk = 1279;
    gq = (4096 + ((mk & 255) << 4)) << (mk >> 8);
    gq = Math.imul(gq, gain >> 3) >> 12;
    if (gq > 65535) gq = 65535;
  }
  if (mode <= NZ_DUST && p[P_E5]) {
    const e = p[P_E5] * 22;
    let r = 1 << (e >> 8);
    r += (r * (e & 255)) >> 8;
    thr = Math.floor((r * THR_K) / 65536);
  }
  if (mode === NZ_LFSR) {
    let mask = taps;
    inc = noiseInc(m.pitch16 + p[P_E7] * 16 + d16);
    mask |= mask >>> 1;
    mask |= mask >>> 2;
    mask |= mask >>> 4;
    mask |= mask >>> 8;
    mask |= mask >>> 16;
    mask >>>= 0;
    if (!(reg & mask)) reg = (rng | 1) >>> 0;
    reg = (reg & mask) >>> 0;
  } else if (mode === NZ_META) {
    inc = p[P_E7] || d16 ? noiseInc(m.pitch16 + p[P_E7] * 16 + d16) : m.inc;
  }
  const seq = SEQ[sel];
  for (let i = 0; i < n; i++) {
    let w: number;
    switch (mode) {
      case NZ_DUST:
      case NZ_ANLG: {
        rng = noiseStep(rng);
        const r = rng >>> 0;
        w = mode === NZ_ANLG ? (r >>> 17) - 16384 : 0;
        if ((r & 0xffff) < thr) {
          const a = 8192 + ((r >>> 18) & 0x7fff);
          w += r & 0x20000 ? a : -a;
        }
        break;
      }
      case NZ_LFSR: {
        const o = ph;
        ph = (ph + inc) >>> 0;
        if (ph < o) reg = ((reg >>> 1) ^ (reg & 1 ? taps : 0)) >>> 0;
        w = reg & 1 ? 12000 : -12000;
        break;
      }
      default: {
        const j = ((ph >>> 16) * seq.len) >>> 16;
        ph = (ph + inc) >>> 0;
        w = (seq.w[j >> 5] >>> (j & 31)) & 1 ? seq.hi : seq.lo;
        break;
      }
    }
    let x = w;
    if (colr) {
      b0 = (Math.imul(b0, PINK0_P) >> 15) + (Math.imul(w, PINK0_G) >> 15);
      b1 = (Math.imul(b1, PINK1_P) >> 15) + (Math.imul(w, PINK1_G) >> 15);
      b2 = (Math.imul(b2, PINK2_P) >> 15) + (Math.imul(w, PINK2_G) >> 14);
      const pk = (b0 + b1 + b2 + (Math.imul(w, 6055) >> 15)) >> 2;
      if (colr <= 64 << 8) {
        x = w + mulq15(pk - w, cf);
      } else {
        br = (Math.imul(br, BROWN_P) >> 15) + (Math.imul(w, BROWN_G) >> 15);
        x = pk + mulq15(br - pk, cf);
      }
    }
    const v3 = x - ic2;
    let v1 = (Math.imul(a1, ic1) + Math.imul(a2, v3) + 4096) >> 13;
    const v2 = ic2 + ((Math.imul(a2, ic1) + Math.imul(a3, v3) + 4096) >> 13);
    ic1 = clamp(2 * v1 - ic1, -150000, 150000);
    ic2 = clamp(2 * v2 - ic2, -150000, 150000);
    v1 = Math.imul(Math.imul(v1, bpg), 3) >> 13;
    let y = v2 + (Math.imul(v1 - v2, mix >> 3) >> 12);
    y = softKnee(Math.imul(y >> 4, gq) >> 8, 24000);
    if (mode === NZ_META) {
      reg = (reg + (((y << 8) - (reg | 0)) >> 9)) >>> 0;
      y -= (reg | 0) >> 8;
    }
    if (crsh) {
      ph = (ph - 1) >>> 0;
      if ((ph | 0) <= 0 || ph > 16) {
        ph = 1 + Math.trunc(crsh / 8);
        const sh = Math.trunc(crsh / 11);
        reg = ((y >> sh) << sh) >>> 0;
      }
      y = reg | 0;
    }
    out[i] += voiceAmp(y, m, i);
  }
  v.s[0] = ic1;
  v.s[1] = ic2;
  v.s[2] = rng;
  v.s[4] = b0;
  v.s[5] = b1;
  v.s[6] = b2;
  v.s[7] = br;
  v.ph[0] = ph;
  v.ph[1] = reg;
  v.ph[2] = drift >>> 0;
}

export const ENG_NOISE: EngineDef = {
  name: "NOISE",
  pageTitle: ["SRC", "MOVE"],
  edit: [
    { label: "MODE", fmt: F.ENUM, min: 0, max: 3, def: 0, names: N_MODE },
    { label: "COLR", fmt: F.PCT, min: 0, max: 127, def: 64 },
    { label: "FREQ", fmt: F.CUTOFF, min: 0, max: 127, def: 80 },
    { label: "RES", fmt: F.PCT, min: 0, max: 127, def: 30 },
    { label: "TRK", fmt: F.PCT, min: 0, max: 127, def: 64 },
    { label: "DENS", fmt: F.PCT, min: 0, max: 127, def: 0 },
    { label: "DRFT", fmt: F.PCT, min: 0, max: 127, def: 0 },
    { label: "CRSH", fmt: F.PCT, min: 0, max: 127, def: 0 },
  ],
  knob: [P_E2, P_E3, P_E1, P_REL],
  keep: 0xf3,
  noteOn,
  render,
  desc(t, k) {
    const mode = t.p[P_E0];
    if (k === 5 && mode >= NZ_LFSR) return mode === NZ_LFSR ? LONG : META;
    if (k === 7 && mode >= NZ_LFSR) return CLK;
    return undefined;
  },
};
void NZ_META;
