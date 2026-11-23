// Port of Felucca-Engines' eng_trio.c (MIT): three oscillators with ring mod and hard sync into a multimode filter.
// See NOTICE.
import { centsInc, clamp, noiseStep, oscTri, pitchInc, softKnee, Tsvf, voiceAmp } from "./dsp";
import { CTL, EngineDef, EngVoice, F, P_E0, P_E1, P_E2, P_E3, P_E4, P_E5, P_E6, P_E7, Track, Vmod } from "./types";

const TW_OFF = 0, TW_TRI = 1, TW_SAW = 2, TW_PLS = 3, TW_NOI = 4, TW_ST = 5, TW_PS = 6;
const RING = 1, SYNC = 2;
const G3 = 11000, G2 = 15000, G1 = 24000;

interface WaveSet { w: [number, number, number]; flags: number; g: [number, number, number] }
const SETS: WaveSet[] = [
  { w: [TW_SAW, TW_SAW, TW_SAW], flags: 0, g: [G3, G3, G3] },
  { w: [TW_PLS, TW_PLS, TW_PLS], flags: 0, g: [G3, G3, G3] },
  { w: [TW_PLS, TW_PLS, TW_TRI], flags: 0, g: [G3, G3, G3 + 3000] },
  { w: [TW_SAW, TW_SAW, TW_TRI], flags: 0, g: [G3, G3, G3 + 3000] },
  { w: [TW_TRI, TW_TRI, TW_TRI], flags: 0, g: [G3 + 2000, G3 + 2000, G3 + 2000] },
  { w: [TW_ST, TW_ST, TW_TRI], flags: 0, g: [G3 + 3000, G3 + 3000, G3] },
  { w: [TW_PS, TW_PS, TW_TRI], flags: 0, g: [G3 + 3000, G3 + 3000, G3] },
  { w: [TW_PLS, TW_OFF, TW_NOI], flags: 0, g: [G2, 0, G2 - 4000] },
  { w: [TW_NOI, TW_OFF, TW_OFF], flags: 0, g: [G1, 0, 0] },
  { w: [TW_SAW, TW_SAW, TW_OFF], flags: SYNC, g: [G2 - 5000, G2 + 5000, 0] },
  { w: [TW_PLS, TW_PLS, TW_OFF], flags: SYNC, g: [G2 - 5000, G2 + 5000, 0] },
  { w: [TW_SAW, TW_SAW, TW_TRI], flags: SYNC, g: [G3 - 3000, G3 + 4000, G3] },
  { w: [TW_TRI, TW_OFF, TW_OFF], flags: RING, g: [G1, 0, 0] },
  { w: [TW_TRI, TW_OFF, TW_TRI], flags: RING, g: [G2 + 2000, 0, G2 - 3000] },
  { w: [TW_TRI, TW_SAW, TW_OFF], flags: RING | SYNC, g: [G2 + 2000, G2, 0] },
  { w: [TW_TRI, TW_PLS, TW_OFF], flags: RING | SYNC, g: [G2 + 2000, G2, 0] },
];
const N_WAVE = ["SAW3", "PLS3", "PPT", "SST", "TRI3", "S&T", "P&S", "P+N", "NOIS", "SYNC", "SYNCP", "SYNC3", "RING", "RING3", "R+S", "R+SP"];
const N_MODE = ["LP", "BP", "HP", "NOT"];
const MIX = [[0, 0, 1024], [0, 1400, 0], [1024, 0, -1024], [1024, 0, 0]];

/** polyBLEP of a step j lying a fraction x (Q15) of a sample before sample i, at level g. */
function blepAt(j: number, x: number, g: number, cr: Int32Array, i: number): void {
  const h = Math.imul(j >> 1, g) >> 15;
  const y = 32767 - x;
  cr[i] += Math.imul(h, Math.imul(x, x) >> 15) >> 15;
  cr[i + 1] -= Math.imul(h, Math.imul(y, y) >> 15) >> 15;
}

/** How far (Q15 of one sample) a phase is past a step it crossed. */
function frac(past: number, inc: number): number {
  const d = inc >>> 15;
  if (!d) return 0;
  const x = Math.floor(past / d);
  return x > 32767 ? 32767 : x;
}

interface Pw { pw: number; pdc: number; psm: number }

const tri16 = (ph: number): number => ((((ph & 0x80000000) ? ~ph >>> 0 : ph) >>> 15) & 0xffff);
const st = (ph: number): number => ((ph >>> 16) & tri16(ph)) - 16384;
const ps = (ph: number, q: Pw): number => (ph >= q.pw ? ph >>> 16 : 0) - q.psm;

function naive(w: number, ph: number, q: Pw): number {
  switch (w) {
    case TW_TRI: return oscTri(ph);
    case TW_SAW: return (ph >>> 16) - 32768;
    case TW_PLS: return (ph < q.pw ? 32767 : -32768) - q.pdc;
    case TW_ST: return st(ph);
    case TW_PS: return ps(ph, q);
    default: return 0;
  }
}

interface NoiseState { nz: number; nst: number }

function pass(w: number, phs: Uint32Array, pi: number, inc: number, g: number, q: Pw, ns: NoiseState, mix: Int32Array, cr: Int32Array, wx: Int16Array | null, n: number): void {
  let ph = phs[pi];
  const pw = q.pw, pdc = q.pdc;
  switch (w) {
    case TW_TRI:
      for (let i = 0; i < n; i++) {
        ph = (ph + inc) >>> 0;
        mix[i] += Math.imul(oscTri(ph), g) >> 15;
      }
      break;
    case TW_SAW:
      for (let i = 0; i < n; i++) {
        const o = ph;
        ph = (ph + inc) >>> 0;
        if (ph < o) {
          const x = frac(ph, inc);
          blepAt(-65536, x, g, cr, i);
          if (wx) wx[i] = x;
        }
        mix[i] += Math.imul((ph >>> 16) - 32768, g) >> 15;
      }
      break;
    case TW_PLS:
      for (let i = 0; i < n; i++) {
        const o = ph;
        ph = (ph + inc) >>> 0;
        if (ph < o) {
          const x = frac(ph, inc);
          blepAt(65535, x, g, cr, i);
          if (wx) wx[i] = x;
        }
        if (((ph - pw) >>> 0) < ((o - pw) >>> 0)) blepAt(-65535, frac((ph - pw) >>> 0, inc), g, cr, i);
        mix[i] += Math.imul((ph < pw ? 32767 : -32768) - pdc, g) >> 15;
      }
      break;
    case TW_NOI:
      for (let i = 0; i < n; i++) {
        const o = ph;
        ph = (ph + inc) >>> 0;
        if ((o ^ ph) & 0x08000000) {
          ns.nst = noiseStep(ns.nst);
          ns.nz = ((ns.nst >>> 0) >>> 16) - 32768;
        }
        mix[i] += Math.imul(ns.nz, g) >> 15;
      }
      break;
    case TW_ST:
      for (let i = 0; i < n; i++) {
        ph = (ph + inc) >>> 0;
        mix[i] += Math.imul(st(ph), g) >> 15;
      }
      break;
    case TW_PS:
      for (let i = 0; i < n; i++) {
        ph = (ph + inc) >>> 0;
        mix[i] += Math.imul(ps(ph, q), g) >> 15;
      }
      break;
    default:
      ph = (ph + Math.imul(inc, n)) >>> 0;
      break;
  }
  phs[pi] = ph;
}

function ring(phs: Uint32Array, pi: number, inc: number, g: number, p3in: number, inc3: number, mix: Int32Array, cr: Int32Array, wx: Int16Array | null, n: number): void {
  let ph = phs[pi];
  let p3 = p3in;
  for (let i = 0; i < n; i++) {
    const o = ph;
    ph = (ph + inc) >>> 0;
    const o3 = p3;
    p3 = (p3 + inc3) >>> 0;
    if (wx && ph < o) wx[i] = frac(ph, inc);
    const s = oscTri(ph);
    const sg = p3 & 0x80000000 ? -g : g;
    if ((o3 ^ p3) & 0x80000000) blepAt(2 * s, frac(p3 & 0x7fffffff, inc3), sg, cr, i);
    mix[i] += Math.imul(s, sg) >> 15;
  }
  phs[pi] = ph;
}

function sync(w: number, phs: Uint32Array, pi: number, inc: number, g: number, q: Pw, wx: Int16Array, mix: Int32Array, cr: Int32Array, n: number): void {
  let ph = phs[pi];
  const pw = q.pw, pdc = q.pdc, pls = w === TW_PLS;
  for (let i = 0; i < n; i++) {
    let o = ph;
    ph = (ph + inc) >>> 0;
    if (wx[i] >= 0) {
      const back = Math.imul(wx[i], inc >>> 15) >>> 0;
      blepAt(naive(w, 0, q) - naive(w, (ph - back) >>> 0, q), wx[i], g, cr, i);
      ph = o = back;
    }
    if (pls) {
      if (ph < o) blepAt(65535, frac(ph, inc), g, cr, i);
      if (((ph - pw) >>> 0) < ((o - pw) >>> 0)) blepAt(-65535, frac((ph - pw) >>> 0, inc), g, cr, i);
      mix[i] += Math.imul((ph < pw ? 32767 : -32768) - pdc, g) >> 15;
    } else {
      if (ph < o) blepAt(-65536, frac(ph, inc), g, cr, i);
      mix[i] += Math.imul((ph >>> 16) - 32768, g) >> 15;
    }
  }
  phs[pi] = ph;
}

const trioInc = (pitch16: number, semi: number, ct: number, fine: number): number => centsInc(pitch16 + semi * 16, ct, fine);

function noteOn(_t: Track, v: EngVoice): void {
  v.ph[0] = 0;
  v.ph[1] = 0x1c000000;
  v.ph[2] = 0x38000000;
  v.s[0] = v.s[1] = 0;
  if (!v.s[2]) v.s[2] = 0x2468ace + v.age;
  v.s[3] = 0;
  v.s[4] = 0;
  v.s[5] = 0;
}

const mix = new Int32Array(CTL);
const cr = new Int32Array(CTL + 1);
const wx = new Int16Array(CTL);

function render(t: Track, v: EngVoice, out: Int32Array, n: number, m: Vmod): void {
  const p = t.p;
  const ws = SETS[p[P_E0] & 15];
  const [w1, w2, w3] = ws.w;
  const isRing = ws.flags & RING, isSync = ws.flags & SYNC;
  const [g1, g2, g3] = ws.g;
  const base = pitchInc(m.pitch16);
  const fine = base >>> 12 ? Math.trunc(((m.inc - base) | 0) / (base >>> 12)) : 0;
  const inc1 = m.inc;
  const inc2 = trioInc(m.pitch16, p[P_E1], p[P_E3], fine);
  const inc3 = trioInc(m.pitch16, p[P_E2], -p[P_E3], fine);
  const duty = clamp((p[P_E7] << 8) + m.shape - (64 << 8), 768, 32000);
  const q: Pw = { pw: (duty << 17) >>> 0, pdc: 2 * duty - 32768, psm: 32768 - ((duty * duty) >> 15) };
  const mode = p[P_E4] & 3;
  const reso = p[P_E6];
  const k = 8192 - Math.trunc((reso * 7168) / 127);
  const ma = MIX[mode][0];
  let mb = MIX[mode][1];
  const mc = MIX[mode][2];
  const flt = new Tsvf();
  const phs = v.ph; // ph[0..2]
  const ph3s = phs[2];
  let ic1 = v.s[0], ic2 = v.s[1];
  const ns: NoiseState = { nst: v.s[2], nz: v.s[3] };
  let prev = v.s[4], drift = v.s[5];
  if (n > CTL) n = CTL;
  if (mode >= 2) mb = -(k >> 2);
  ns.nst = noiseStep(ns.nst);
  drift += ((((ns.nst >>> 0) >>> 22) - 512 - drift) >> 3);
  const cut = clamp((p[P_E5] << 8) + m.cutoff + drift, 0, 127 << 8);
  flt.setK(cut, k);
  const { a1, a2, a3 } = flt;
  for (let i = 0; i < n; i++) { mix[i] = cr[i] = 0; wx[i] = -1; }
  cr[n] = 0;
  pass(w3, phs, 2, inc3, g3, q, ns, mix, cr, null, n);
  if (isRing) ring(phs, 0, inc1, g1, ph3s, inc3, mix, cr, isSync ? wx : null, n);
  else pass(w1, phs, 0, inc1, g1, q, ns, mix, cr, isSync ? wx : null, n);
  if (isSync) sync(w2, phs, 1, inc2, g2, q, wx, mix, cr, n);
  else pass(w2, phs, 1, inc2, g2, q, ns, mix, cr, null, n);
  let cur = prev;
  for (let i = 0; i < n; i++) {
    let x = cur + cr[i];
    cur = mix[i];
    x = softKnee(x, 16000) >> 1;
    const v3 = x - ic2;
    const v1 = (Math.imul(a1, ic1) + Math.imul(a2, v3)) >> 13;
    const v2 = ic2 + ((Math.imul(a2, ic1) + Math.imul(a3, v3)) >> 13);
    ic1 = 2 * v1 - ic1;
    ic2 = clamp(2 * v2 - ic2, -150000, 150000);
    const a = clamp(ic1, -49152, 49152);
    ic1 = a + ((ic1 - a) >> 2);
    const y = softKnee((Math.imul(x, ma) + Math.imul(v1, mb) + Math.imul(v2, mc)) >> 10, 16000);
    out[i] += voiceAmp(y << 1, m, i) << 1;
  }
  prev = cur + cr[n];
  v.s[0] = ic1;
  v.s[1] = ic2;
  v.s[2] = ns.nst;
  v.s[3] = ns.nz;
  v.s[4] = prev;
  v.s[5] = drift;
}

export const ENG_TRIO: EngineDef = {
  name: "TRIO",
  pageTitle: ["OSC", "TONE"],
  edit: [
    { label: "WAVE", fmt: F.ENUM, min: 0, max: 15, def: 0, names: N_WAVE },
    { label: "INT2", fmt: F.SEMI, min: -24, max: 24, def: 0 },
    { label: "INT3", fmt: F.SEMI, min: -24, max: 24, def: -12 },
    { label: "DTN", fmt: F.INT, min: 0, max: 50, def: 6, unit: "ct" },
    { label: "MODE", fmt: F.ENUM, min: 0, max: 3, def: 0, names: N_MODE },
    { label: "CUT", fmt: F.CUTOFF, min: 0, max: 127, def: 80 },
    { label: "RES", fmt: F.PCT, min: 0, max: 127, def: 40 },
    { label: "PW", fmt: F.PCT, min: 0, max: 127, def: 64 },
  ],
  knob: [P_E5, P_E6, P_E7, P_E1],
  keep: 0x03,
  noteOn,
  render,
};
