// Port of Felucca-Engines' eng_analog.c (MIT): two band-limited oscillators, noise, drive and an SVF. See NOTICE.
import {
  blep, centsInc, clamp, mulq15, noiseStep, oscPulse, oscSaw, oscSine, oscTri, pitchInc, softclip, softKnee, Tsvf, tsvfLp, voiceAmp,
} from "./dsp";
import { EngineDef, EngVoice, F, P_E0, P_E1, P_E2, P_E3, P_E4, P_E5, P_E6, P_E7, P_FTYPE, P_REL, P_ATK, ParamDesc, Track, Vmod } from "./types";

const WAVES = ["SAW", "SQR", "TRI", "SIN", "PWM", "SYNC", "SUB"];
const AW_SYNC = 5, AW_SUB = 6;
const SYNC: ParamDesc = { label: "SYNC", fmt: F.INT, min: 0, max: 127, def: 10 };
const SUB: ParamDesc = { label: "SUB", fmt: F.PCT, min: 0, max: 127, def: 64 };
const analogK = (res: number): number => 8192 - Math.trunc((res * 7600) / 127);

/** The SVF with taps: 0 LP, 1 BP, 2 HP. */
function analogTap(c: Tsvf, k: number, input: number, s: Int32Array, ft: number): number {
  const v3 = input - s[1];
  const v1 = (Math.imul(c.a1, s[0]) + Math.imul(c.a2, v3)) >> 13;
  const v2 = s[1] + ((Math.imul(c.a2, s[0]) + Math.imul(c.a3, v3)) >> 13);
  s[0] = clamp(2 * v1 - s[0], -150000, 150000);
  s[1] = clamp(2 * v2 - s[1], -150000, 150000);
  if (!ft) return v2;
  return ft === 1 ? v1 : input - ((Math.imul(k, v1)) >> 12) - v2;
}

function noteOn(_t: Track, v: EngVoice): void {
  v.ph[1] = (v.ph[0] + 0x40000000) >>> 0;
  v.s[0] = v.s[1] = 0;
  if (!v.s[2]) v.s[2] = 0x1234567 + v.age;
  v.s[3] = 0;
}

function renderX(t: Track, v: EngVoice, out: Int32Array, n: number, m: Vmod): void {
  const p = t.p;
  const sub = p[P_E0] === AW_SUB;
  const det = p[P_E1], mix = p[P_E2], noise = p[P_E3];
  const cut = (p[P_E4] << 8) + m.cutoff + ((p[P_E7] * (v.pitch16 - 60 * 16)) >> 4);
  const flt = new Tsvf();
  const drive = 32768 + p[P_E6] * 512;
  const m2 = mix * 258, m1 = 32767 - m2;
  const nz = noise * 200, drv = p[P_E6];
  let ph0 = v.ph[0], ph1 = v.ph[1];
  const inc1 = m.inc;
  let inc2: number;
  let nst = v.s[2];
  let jl = v.s[3];
  if (sub) {
    inc2 = (det ? centsInc(m.pitch16, det, 0) : inc1) >>> 1;
  } else {
    inc2 = pitchInc(clamp(m.pitch16 + det * 3 + (((m.shape - (64 << 8)) * 3) >> 8), 0, 2047));
    if (m.fine) inc2 = (inc2 + Math.imul(inc2 >>> 12, m.fine)) >>> 0;
  }
  const ft = p[P_FTYPE];
  const fk = analogK(p[P_E5]);
  flt.set(cut, p[P_E5]);
  const st = v.s; // filter state at s[0], s[1]
  for (let i = 0; i < n; i++) {
    const a = oscSaw(ph0, inc1);
    let b: number;
    if (sub) {
      b = oscPulse(ph1, inc2, 0x80000000);
    } else {
      let bl = blep(ph1, inc2);
      if (jl) {
        bl = Math.imul(bl, (jl - 1) >> 1) >> 15;
        jl = 0;
      }
      b = (ph1 >>> 16) - 32768 - bl;
      if (ph0 > 0xffffffff - inc1) b -= Math.imul(blep(ph0, inc1), ph1 >>> 17) >> 15;
    }
    ph0 = (ph0 + inc1) >>> 0;
    ph1 = (ph1 + inc2) >>> 0;
    if (!sub && ph0 < inc1) {
      const f = Math.floor(ph0 / ((inc1 >>> 16) | 1));
      const at = (ph1 - Math.imul(f, inc2 >>> 16)) >>> 0;
      jl = (at >>> 16) + 1;
      ph1 = Math.imul(f, inc2 >>> 16) >>> 0;
    }
    let s = mulq15(a, m1) + mulq15(b, m2);
    if (nz) {
      nst = noiseStep(nst);
      s += mulq15(((nst >>> 0) >>> 17) - 16384, nz);
    }
    if (drv) s = softclip(Math.imul(s >> 2, drive >> 2) >> 11);
    s = softKnee(analogTap(flt, fk, s >> 1, st, ft), 16000) * 2;
    out[i] += voiceAmp(s, m, i) * 2;
  }
  v.ph[0] = ph0;
  v.ph[1] = ph1;
  v.s[2] = nst;
  v.s[3] = jl;
}

function renderOsc(t: Track, v: EngVoice, out: Int32Array, n: number, m: Vmod, ft: number): void {
  const p = t.p;
  const wave = p[P_E0];
  const det = p[P_E1], mix = p[P_E2], noise = p[P_E3];
  const cut = (p[P_E4] << 8) + m.cutoff + ((p[P_E7] * (v.pitch16 - 60 * 16)) >> 4);
  const flt = new Tsvf();
  const drive = 32768 + p[P_E6] * 512;
  const inc1 = m.inc;
  const inc2 = det ? centsInc(m.pitch16, det, 0) : inc1;
  const pw = (0x80000000 + ((m.shape - (64 << 8)) << 15)) >>> 0;
  const m2 = mix * 258, m1 = 32767 - m2;
  const nz = noise * 200, drv = p[P_E6];
  let ph0 = v.ph[0], ph1 = v.ph[1];
  let nst = v.s[2];
  const fk = ft ? analogK(p[P_E5]) : 0;
  flt.set(cut, p[P_E5]);
  const st = v.s;
  for (let i = 0; i < n; i++) {
    let a: number, b: number;
    switch (wave) {
      case 1: a = oscPulse(ph0, inc1, 0x80000000); b = oscPulse(ph1, inc2, 0x80000000); break;
      case 2: a = oscTri(ph0); b = oscTri(ph1); break;
      case 3: a = oscSine(ph0); b = oscSine(ph1); break;
      case 4: a = oscPulse(ph0, inc1, pw); b = oscPulse(ph1, inc2, pw); break;
      default: a = oscSaw(ph0, inc1); b = oscSaw(ph1, inc2); break;
    }
    ph0 = (ph0 + inc1) >>> 0;
    ph1 = (ph1 + inc2) >>> 0;
    let s = mulq15(a, m1) + mulq15(b, m2);
    if (nz) {
      nst = noiseStep(nst);
      s += mulq15(((nst >>> 0) >>> 17) - 16384, nz);
    }
    if (drv) s = softclip(Math.imul(s >> 2, drive >> 2) >> 11);
    let y = ft ? analogTap(flt, fk, s >> 1, st, ft) : tsvfLp(flt, s >> 1, st, 0);
    let ay = y < 0 ? -y : y;
    if (ay > 16000) {
      ay = 16000 + (softclip((ay - 16000) * 2) >> 1);
      y = y < 0 ? -ay : ay;
    }
    s = y * 2;
    out[i] += voiceAmp(s, m, i) * 2;
  }
  v.ph[0] = ph0;
  v.ph[1] = ph1;
  v.s[2] = nst;
}

function render(t: Track, v: EngVoice, out: Int32Array, n: number, m: Vmod): void {
  if (t.p[P_E0] >= AW_SYNC) renderX(t, v, out, n, m);
  else renderOsc(t, v, out, n, m, t.p[P_FTYPE]);
}

export const ENG_ANALOG: EngineDef = {
  name: "ANALOG",
  pageTitle: ["OSC", "FLT"],
  edit: [
    { label: "WAVE", fmt: F.ENUM, min: 0, max: 6, def: 0, names: WAVES },
    { label: "DTN", fmt: F.INT, min: 0, max: 127, def: 10, unit: "ct" },
    { label: "MIX", fmt: F.PCT, min: 0, max: 127, def: 64 },
    { label: "NOIS", fmt: F.PCT, min: 0, max: 127, def: 0 },
    { label: "CUT", fmt: F.CUTOFF, min: 0, max: 127, def: 90 },
    { label: "RES", fmt: F.PCT, min: 0, max: 127, def: 30 },
    { label: "DRV", fmt: F.PCT, min: 0, max: 127, def: 0 },
    { label: "KTR", fmt: F.PCT, min: 0, max: 127, def: 64 },
  ],
  knob: [P_E4, P_E5, P_ATK, P_REL],
  keep: 0x03,
  noteOn,
  render,
  desc(t, k) {
    if (k === 1 && t.p[P_E0] === AW_SYNC) return SYNC;
    if (k === 2 && t.p[P_E0] === AW_SUB) return SUB;
    return undefined;
  },
};
