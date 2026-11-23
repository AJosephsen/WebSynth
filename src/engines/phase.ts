// Port of Felucca-Engines' eng_phase.c (MIT): phase distortion with a second line, sub oscillator and sine wavefolder.
// See NOTICE.
import { clamp, mulq15, oscSine, pitchInc, sineI, voiceAmp } from "./dsp";
import { CTL, EngineDef, EngVoice, F, FS, P_E0, P_E1, P_E2, P_E3, P_E4, P_E5, P_E6, P_E7, P_REL, Track, Vmod } from "./types";

const N_WAVE = ["SAW", "SQR", "PLS", "DSIN", "SPLS", "RSAW", "RTRI", "RTRP"];
const N_WAVE2 = ["-", "SAW", "SQR", "PLS", "DSIN", "SPLS", "RSAW", "RTRI", "RTRP"];
const N_LINE = ["MIX", "RING"];
const UNFOLDED = -2147483648;
const FOLD_G0 = 163;
const FOLD_REF = Math.floor((440 * 2 ** 32) / FS);

/** floor(x / 65536) for non-negative doubles (the C code does these shifts on uint32). */
const sh16 = (x: number): number => Math.floor(x / 65536);
/** -cos, Q15, from the 16-bit PD phase. */
const pdCos = (ph16: number): number => -sineI((((ph16 & 0xffff) << 16) + 0x40000000) >>> 0);
const slope = (span: number, len: number): number => Math.floor((span * 65536) / (len || 1));

class Pd {
  w = 0; x = 0; peak = 0; rez = 0; k0 = 0; k1 = 0;
}

function setup(b: Pd, w: number, dcw: number): void {
  let x: number;
  b.w = w;
  switch (w) {
    case 0:
      x = 32768 + sh16(dcw * 32767);
      b.k0 = slope(32768, x);
      b.k1 = slope(32767, 65535 - x);
      break;
    case 1:
      x = 32768 - sh16(dcw * 31120);
      b.k0 = slope(32768, x);
      b.k1 = slope(32767, x);
      break;
    case 2:
      x = 65535 - sh16(dcw * 63487);
      b.k0 = slope(65535, x);
      break;
    case 3:
      x = 65535 - sh16(dcw * 49151);
      b.k0 = slope(65535, x);
      b.k1 = slope(65535, 65535 - x);
      break;
    case 4:
      x = 65535 - sh16(dcw * 32767);
      b.peak = sh16(x * (32768 + sh16(dcw * 29491)));
      if (!b.peak) b.peak = 1;
      b.k0 = slope(32768, b.peak);
      b.k1 = slope(32767, x - b.peak);
      break;
    default:
      x = 0;
      b.rez = sh16(dcw * 44000);
      break;
  }
  b.x = x;
}

function wave(b: Pd, ph: number): number {
  const x = b.x;
  let pd: number;
  switch (b.w) {
    case 0: pd = ph < x ? sh16(ph * b.k0) : 32768 + sh16((ph - x) * b.k1); break;
    case 1:
      if (ph < x) pd = sh16(ph * b.k0);
      else if (ph < 32768) pd = 32768;
      else if (ph < 32768 + x) pd = 32768 + sh16((ph - 32768) * b.k1);
      else pd = 65535;
      break;
    case 2: pd = ph < x ? sh16(ph * b.k0) : 65535; break;
    case 3: pd = ph < x ? sh16(ph * b.k0) : sh16((ph - x) * b.k1); break;
    case 4:
      if (ph >= x) pd = 65535;
      else if (ph < b.peak) pd = sh16(ph * b.k0);
      else pd = 32768 + sh16((ph - b.peak) * b.k1);
      break;
    default: {
      const rp = (ph + sh16(ph * b.rez) * 7) & 0xffff;
      const core = Math.imul(pdCos(rp), 5) >> 3;
      let win: number;
      if (b.w === 5) win = 65535 - ph;
      else if (b.w === 6) win = ph < 32768 ? ph << 1 : (65535 - ph) << 1;
      else win = ph < 16384 ? ph << 2 : ph > 49152 ? (65535 - ph) << 2 : 65535;
      if (win > 65535) win = 65535;
      return Math.imul(core, win) >> 16;
    }
  }
  return pdCos(pd);
}

function noteOn(t: Track, v: EngVoice): void {
  v.ph[1] = 0;
  v.ph[2] = 0;
  v.s[0] = 0;
  v.s[1] = 0;
  v.s[4] = t.p[P_E7] > 0 ? 0 : UNFOLDED;
  v.s[5] = 0;
  v.s[6] = FOLD_G0;
}

function foldGain(fold: number, inc: number): number {
  let ext = Math.floor((fold * ((2048 - FOLD_G0) << 4)) / 127);
  if (inc > FOLD_REF) ext = Math.floor((ext * (FOLD_REF >>> 12)) / (inc >>> 12));
  return FOLD_G0 + (ext >> 4);
}

const b1 = new Pd();
const b2 = new Pd();

function loop(t: Track, v: EngVoice, out: Int32Array, n: number, m: Vmod, fg: number): void {
  const p = t.p;
  const w1 = p[P_E0] & 7, w2 = p[P_E1];
  let depth = (p[P_E2] << 8) + m.cutoff + mulq15(m.envq15, p[P_E3] * 256);
  const inc = m.inc;
  const det = p[P_E4];
  const line2 = det !== 0 || p[P_E5] !== 0;
  const ring = p[P_E5];
  const sub = p[P_E6] * 200;
  const d16 = Math.trunc((det * 16) / 100);
  const rem = det * 16 - d16 * 100;
  let ph0 = v.ph[0], ph1 = v.ph[1], ph2 = v.ph[2];
  let tg0 = v.s[0], tg1 = v.s[1];
  let fx1 = fg ? v.s[4] : 0;
  let fhp = fg ? v.s[5] : 0;
  depth = clamp(depth + (m.shape - (64 << 8)), 0, 127 << 8);
  let dcw = Math.floor((depth * 65535) / (127 << 8));
  dcw = sh16(dcw * 56000);
  let inc2 = pitchInc(clamp(m.pitch16 + d16, 0, 2047));
  inc2 = (inc2 + Math.imul(inc2 >>> 12, Math.trunc((rem * 2367) / 16000))) >>> 0;
  setup(b1, w1, dcw);
  setup(b2, w2 ? w2 - 1 : w1, dcw);
  for (let i = 0; i < n; i++) {
    const old = ph0;
    let s = wave(tg0 ? b2 : b1, ph0 >>> 16);
    ph0 = (ph0 + inc) >>> 0;
    if (ph0 < old) tg0 ^= 1;
    if (line2) {
      const old2 = ph1;
      const s2 = wave(tg1 ? b2 : b1, ph1 >>> 16);
      ph1 = (ph1 + inc2) >>> 0;
      if (ph1 < old2) tg1 ^= 1;
      s = ring ? mulq15(s, s2) : (s + s2) >> 1;
    }
    if (fg) {
      const f = sineI((Math.imul(s, fg) << 7) >>> 0);
      fhp += f - fx1 - (fhp >> 9);
      fx1 = f;
      s = fhp;
    }
    if (sub) {
      ph2 = (ph2 + (inc >>> 1)) >>> 0;
      s += mulq15(oscSine(ph2), sub);
    }
    if (fg) s = clamp(s, -65535, 65535);
    out[i] += voiceAmp(s, m, i) * 2;
  }
  v.ph[0] = ph0;
  v.ph[1] = ph1;
  v.ph[2] = ph2;
  v.s[0] = tg0;
  v.s[1] = tg1;
  if (fg) {
    v.s[4] = fx1;
    v.s[5] = fhp;
    v.s[6] = fg;
  }
}

const xa = new Int32Array(CTL);
const xb = new Int32Array(CTL);

/** FOLD going on or off: that block is rendered both ways and crossfaded. */
function xfade(t: Track, v: EngVoice, out: Int32Array, n: number, m: Vmod, on: boolean): void {
  const ph0 = v.ph[0], ph1 = v.ph[1], ph2 = v.ph[2];
  const tg0 = v.s[0], tg1 = v.s[1];
  if (n > CTL) n = CTL;
  xa.fill(0, 0, n);
  xb.fill(0, 0, n);
  loop(t, v, xa, n, m, 0);
  v.ph[0] = ph0;
  v.ph[1] = ph1;
  v.ph[2] = ph2;
  v.s[0] = tg0;
  v.s[1] = tg1;
  if (on) {
    v.s[4] = v.s[5] = 0;
    loop(t, v, xb, n, m, foldGain(t.p[P_E7], m.inc));
  } else {
    loop(t, v, xb, n, m, v.s[6]);
    v.s[4] = UNFOLDED;
  }
  for (let i = 0; i < n; i++) {
    const k = on ? i + 1 : n - 1 - i;
    out[i] += xa[i] + Math.trunc(Math.imul(xb[i] - xa[i], k) / n);
  }
}

function render(t: Track, v: EngVoice, out: Int32Array, n: number, m: Vmod): void {
  if (t.p[P_E7] > 0) {
    if (v.s[4] === UNFOLDED) xfade(t, v, out, n, m, true);
    else loop(t, v, out, n, m, foldGain(t.p[P_E7], m.inc));
  } else if (v.s[4] !== UNFOLDED) {
    xfade(t, v, out, n, m, false);
  } else {
    loop(t, v, out, n, m, 0);
  }
}

export const ENG_PHASE: EngineDef = {
  name: "PHASE",
  pageTitle: ["PHS", "LINE"],
  edit: [
    { label: "WAVE", fmt: F.ENUM, min: 0, max: 7, def: 0, names: N_WAVE },
    { label: "WAVE2", fmt: F.ENUM, min: 0, max: 8, def: 0, names: N_WAVE2 },
    { label: "DCW", fmt: F.PCT, min: 0, max: 127, def: 60 },
    { label: "ENV", fmt: F.PCT, min: 0, max: 127, def: 64 },
    { label: "DTN", fmt: F.INT, min: 0, max: 127, def: 0, unit: "ct" },
    { label: "LINE", fmt: F.ENUM, min: 0, max: 1, def: 0, names: N_LINE },
    { label: "SUB", fmt: F.PCT, min: 0, max: 127, def: 0 },
    { label: "FOLD", fmt: F.PCT, min: 0, max: 127, def: 0 },
  ],
  knob: [P_E2, P_E3, P_E4, P_REL],
  keep: 0x30,
  noteOn,
  render,
};
