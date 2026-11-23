// Port of Felucca-Engines' eng_wheel.c (MIT): a tonewheel-style additive organ with percussion, click, drive and rotary.
// See NOTICE.
import { clamp, mulq15, noiseStep, sineI, softclip, voiceAmp } from "./dsp";
import { SINE } from "../fm6/tables";
import { CTL, EngineDef, EngVoice, F, FS, NVOICE, P_E0, P_E1, P_E2, P_E3, P_E4, P_E5, P_E6, P_E7, Track, Vmod } from "./types";

const NP = 9; // partials
const FOLD = Math.floor((584366000 * 44100) / FS); // ~6 kHz as a phase increment
const XOVER = Math.floor((77915000 * 44100) / FS); // ~800 Hz
const PDEC_SLOW = 65457, PDEC_FAST = 65219, CLKDEC = 24576;
const LV = [0, 2920, 4125, 5827, 8231, 11627, 16423, 23198, 32767];
const N_REG = ["FLUTE", "MELLO", "HOLLW", "SMOOT", "3BAR", "BLUES", "GOSPL", "ROCK", "TOPS", "CLARI", "REED", "STRNG", "CHAPL", "BRITE", "BASS", "FULL"];
const REG = ["008000000", "008400000", "800800000", "838000000", "888000000", "888800000", "888600006", "888000888", "800000888", "008080800", "008765432", "006876540", "004432000", "008888000", "858000000", "888888888"];
const N_PERC = ["OFF", "2ND", "3RD", "2SOFT", "3SOFT", "2SLOW", "3SLOW"];
const N_ROTR = ["OFF", "SLOW", "FAST"];
const FOLD_LIM = [FOLD * 2, Math.floor(FOLD / 3) * 2, FOLD, Math.floor(FOLD / 2), Math.floor(FOLD / 3), Math.floor(FOLD / 4), Math.floor(FOLD / 5), Math.floor(FOLD / 6), Math.floor(FOLD / 8)];

function ratio(k: number, x: number): number {
  switch (k) {
    case 0: return x >>> 1;
    case 1: return (x + (x >>> 1)) >>> 0;
    case 2: return x;
    case 3: return (x << 1) >>> 0;
    case 4: return Math.imul(x, 3) >>> 0;
    case 5: return (x << 2) >>> 0;
    case 6: return Math.imul(x, 5) >>> 0;
    case 7: return Math.imul(x, 6) >>> 0;
    default: return (x << 3) >>> 0;
  }
}

const HZ = (h: number): number => Math.trunc(h * 3116457.0 * (44100.0 / FS));
const ROT_SPD = [[0, HZ(0.8), HZ(6.7)], [0, HZ(0.7), HZ(5.8)]];

/** Per-part state, once per block. */
class PartState {
  g = new Int32Array(NP);
  pk = NP; plev = 0; pdec = 0; clk = 0; dg = 0; dcomp = 0;
  rph = new Uint32Array(2);
  rsp = new Int32Array(2);
  rwet = 0;
  am = new Int32Array(2);
  fm = new Int32Array(2);
  voices = Array.from({ length: NVOICE }, () => new VoiceState());
}
class VoiceState {
  ph = new Uint32Array(NP);
  gp = new Int32Array(NP);
  perc = 0; clk = 0; nz = 0; hp = 0; gate = 0; init = false;
}

let parts = new WeakMap<Track, PartState>();
function part(t: Track): PartState {
  let s = parts.get(t);
  if (!s) { s = new PartState(); parts.set(t, s); }
  return s;
}

const level = (p: Int16Array, k: number): number => {
  let d = REG[p[P_E0] & 15].charCodeAt(k) - 48;
  d += k < 2 ? p[P_E1] : k < 4 ? p[P_E2] : p[P_E3];
  return clamp(d, 0, 8);
};

function block(t: Track): void {
  const T = part(t);
  const p = t.p;
  const perc = p[P_E4] % 7;
  const rot = p[P_E7] % 3;
  let s = 0;
  const lv: number[] = [];
  for (let k = 0; k < NP; k++) {
    lv[k] = perc && k === NP - 1 ? 0 : LV[level(p, k)];
    s += lv[k];
  }
  let norm = Math.floor((2 * 39322 * 32768) / (s + 49152));
  if (perc === 1 || perc === 2 || perc === 5 || perc === 6) norm = Math.floor((norm * 23170) / 32768);
  for (let k = 0; k < NP; k++) T.g[k] = Math.floor((lv[k] * norm) / 32768);
  T.pk = perc ? 3 + ((perc - 1) & 1) : NP;
  T.plev = perc === 3 || perc === 4 ? 12000 : 24000;
  T.pdec = perc >= 5 ? PDEC_SLOW : PDEC_FAST;
  T.clk = p[P_E5] * 180;
  if (p[P_E6]) {
    T.dg = 256 + p[P_E6] * 6;
    T.dcomp = Math.trunc((6 * 256 * 256) / (512 + T.dg));
  } else {
    T.dg = 0;
  }
  for (let k = 0; k < 2; k++) {
    T.rsp[k] += (ROT_SPD[k][rot] - T.rsp[k]) >> (k ? 11 : 9);
    const sp = T.rsp[k];
    T.rph[k] += sp >>> 0;
    const sn = sineI(T.rph[k]);
    const c = sineI((T.rph[k] + 0x40000000) >>> 0);
    const dep = k ? 7000 : 13000;
    T.am[k] = 32767 - mulq15(dep, (32767 - c) >> 1);
    T.fm[k] = Math.imul(sn, sp >> (k ? 17 : 16)) >> 15;
  }
  T.rwet += ((rot ? 32767 : 0) - T.rwet) >> 5;
  for (let k = 0; k < 2; k++) {
    T.am[k] = 32767 - mulq15(T.rwet, 32767 - T.am[k]);
    T.fm[k] = mulq15(T.fm[k], T.rwet);
  }
}

function noteOn(t: Track, v: EngVoice): void {
  const vi = t.v.indexOf(v) % NVOICE;
  const V = part(t).voices[vi];
  let held = false;
  for (const o of t.v) if (o !== v && o.active && o.gate && o.stage !== 4) held = true;
  if (!V.init) {
    for (let k = 0; k < NP; k++) V.ph[k] = (Math.imul(k, 0x9e3779b9) ^ Math.imul(vi, 0x7f4a7c15)) >>> 0;
    V.nz = 0x13579bdf + vi;
    V.init = true;
  }
  V.perc = held ? 0 : 32767;
  V.clk = 32767;
  V.hp = 0;
  V.gate = 1;
}

const acc = new Int32Array(CTL);

function render(t: Track, v: EngVoice, out: Int32Array, n: number, m: Vmod): void {
  const T = part(t);
  const V = T.voices[t.v.indexOf(v) % NVOICE];
  if (n > CTL) n = CTL;
  acc.fill(0, 0, n);
  const perc1 = Math.floor((V.perc * T.pdec) / 65536);
  for (let k = 0; k < NP; k++) {
    let x = m.inc;
    let ph = V.ph[k];
    let g1 = T.g[k];
    const g0 = V.gp[k];
    if (k === T.pk) g1 += mulq15(T.plev, perc1);
    while (x > FOLD_LIM[k]) x >>>= 1;
    let inc = ratio(k, x);
    const r = inc < XOVER ? 1 : 0;
    g1 = mulq15(g1, T.am[r]);
    inc = (inc + Math.imul(inc >>> 16, T.fm[r])) >>> 0;
    V.gp[k] = g1;
    if (!g0 && !g1) {
      V.ph[k] = (ph + Math.imul(inc, n)) >>> 0;
      continue;
    }
    if (g0 === g1) {
      for (let i = 0; i < n; i++) {
        ph = (ph + inc) >>> 0;
        acc[i] += Math.imul(SINE[ph >>> 22], g1) >> 15;
      }
    } else {
      let gq = g0 << 5;
      const dg = g1 - g0;
      for (let i = 0; i < n; i++) {
        ph = (ph + inc) >>> 0;
        gq += dg;
        acc[i] += Math.imul(SINE[ph >>> 22], gq >> 5) >> 15;
      }
    }
    V.ph[k] = ph;
  }
  V.perc = perc1;
  if (V.gate && !v.gate) {
    V.gate = 0;
    V.clk = 16384;
  }
  let clk0 = mulq15(V.clk, T.clk);
  if (clk0 > 16) {
    let nst = V.nz, hp = V.hp;
    V.clk = Math.imul(V.clk, CLKDEC) >> 15;
    const clk1 = mulq15(V.clk, T.clk);
    const dc = clk1 - clk0;
    clk0 <<= 5;
    for (let i = 0; i < n; i++) {
      nst = noiseStep(nst);
      const z = ((nst >>> 0) >>> 17) - 16384;
      const y = z - hp;
      hp += y >> 3;
      clk0 += dc;
      acc[i] += Math.imul(y, clk0 >> 5) >> 15;
    }
    V.nz = nst;
    V.hp = hp;
  }
  if (T.dg) {
    const dg = T.dg, dcomp = T.dcomp;
    for (let i = 0; i < n; i++) acc[i] = Math.imul(softclip(Math.imul(acc[i], dg) >> 9), dcomp) >> 8;
  }
  for (let i = 0; i < n; i++) out[i] += voiceAmp(acc[i] >> 1, m, i) << 1;
}

export const ENG_WHEEL: EngineDef = {
  name: "WHEEL",
  pageTitle: ["BARS", "TONE"],
  edit: [
    { label: "REG", fmt: F.ENUM, min: 0, max: 15, def: 4, names: N_REG },
    { label: "SUB", fmt: F.INT, min: -8, max: 8, def: 0 },
    { label: "BODY", fmt: F.INT, min: -8, max: 8, def: 0 },
    { label: "TOP", fmt: F.INT, min: -8, max: 8, def: 0 },
    { label: "PERC", fmt: F.ENUM, min: 0, max: 6, def: 0, names: N_PERC },
    { label: "CLICK", fmt: F.PCT, min: 0, max: 127, def: 40 },
    { label: "DRV", fmt: F.PCT, min: 0, max: 127, def: 0 },
    { label: "ROTR", fmt: F.ENUM, min: 0, max: 2, def: 1, names: N_ROTR },
  ],
  knob: [P_E0, P_E4, P_E6, P_E7],
  keep: 0,
  noteOn,
  render,
  block,
  reset() { parts = new WeakMap(); },
};
