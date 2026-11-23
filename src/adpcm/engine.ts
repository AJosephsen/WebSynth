// Port of Felucca's eng_adpcm.c (GPL-3.0-only): the ADPCM engine. Short 4-bit BRR waves through a Gaussian interpolator,
// stepped ADSR / GAIN envelopes, a noise source and an echo with an 8-tap FIR, on the DSP of snes_spc (adpcm_dsp.c). Each
// part is one DSP: its voices share the rate counter and the noise, and it has its echo. See NOTICE.
import { mulq15, voiceAmp, VOICE_FS } from "../engines/dsp";
import { clamp } from "../engines/dsp";
import { EngineDef, EngVoice, F, P_ATK, P_DEC, P_E0, P_E1, P_E2, P_E3, P_E4, P_E5, P_E6, P_E7, P_REL, P_SUS, CTL, Track, Vmod } from "../engines/types";
import { pow2q16 } from "../sampler/base";
import { ADP_BRR, ADP_INST } from "./data";
import {
  AdpChv, AdpEcho, ADP_CTR_RATE, adpClamp16, adpCtr, adpEchoTick, adpNoiseStep, adpTick, SE_ATTACK,
} from "./dsp";

const ADP_RATE_Q16 = 47555; // 32000 / 44100, Q16: DSP samples per output sample
const ADP_ONE = 1 << 16;
const ADP_VOL_SH = 2;
const ADP_TICKS = 24;
const ADP_EDL_MAX = 12;
const NVOICE = 8;

class AdpVoice { c = new AdpChv(); inst = 0; down = 0; o0 = 0; o1 = 0; }
class AdpDsp {
  noise = 0;
  rc = new Int16Array(32);
  ph = 0; ph0 = 0;
  fire = new Uint32Array(ADP_TICKS);
  nz = new Int16Array(ADP_TICKS);
  ein = new Int16Array(ADP_TICKS);
  ec = new AdpEcho();
  e0 = 0; e1 = 0;
  quiet = 0;
  qlo = [0, 0]; qhi = [0, 0];
  init = 0; edirty = 0;
}
class AdpPart {
  v = Array.from({ length: NVOICE }, () => new AdpVoice());
  d = new AdpDsp();
  line = new Int16Array(ADP_EDL_MAX * 512);
}
const parts = new WeakMap<Track, AdpPart>();
const partOf = (t: Track): AdpPart => {
  let a = parts.get(t);
  if (!a) { a = new AdpPart(); parts.set(t, a); }
  return a;
};
const voiceOf = (t: Track, v: EngVoice): AdpVoice => partOf(t).v[t.v.indexOf(v) % NVOICE];

export let adpEclips = 0;

/** FIR settings: none, a low-pass, a high-pass, a band-pass (C0 .. C7). */
const ADP_FIRS = [
  [127, 0, 0, 0, 0, 0, 0, 0],
  [0x0c, 0x21, 0x2b, 0x2b, 0x13, -0x02, -0x0d, -0x07],
  [0x58, -0x41, -0x25, -0x10, -0x02, 0x07, 0x0c, 0x0c],
  [0x34, 0x33, 0x00, -0x27, -0x1b, 0x01, -0x04, -0x15],
];
const N_ADP_FIR = ["FLAT", "LOW", "HIGH", "BAND"];
const N_ADP_EDL = ["0", "16", "32", "48", "64", "80", "96", "112", "128", "144", "160", "176", "192"];

/** ATK DEC SUS (0..127) to ADSR's AR (15 = at once), DR, SL; SR (E3) as it is. */
function adsr(t: Track, sv: AdpVoice): void {
  const p = t.p;
  const ar = 15 - Math.floor((p[P_ATK] * 15 + 63) / 127), dr = 7 - Math.floor((p[P_DEC] * 7 + 63) / 127);
  const sl = Math.floor((p[P_SUS] * 7 + 63) / 127);
  sv.c.adsr0 = 0x80 | (dr << 4) | ar;
  sv.c.adsr1 = (sl << 5) | (p[P_E2] & 31);
}

function adpPitch(t: Track, sv: AdpVoice, m: Vmod): number {
  const d16 = clamp(m.pitch16 + t.p[P_E1] * 16 - ADP_INST[sv.inst].root16, -3072, 384);
  let pr = pow2q16(d16) >>> 4;
  if (m.fine) pr += Math.imul(pr, m.fine) >> 12;
  return clamp(pr, 0, 0x3fff);
}

function noteOn(t: Track, v: EngVoice): void {
  const sv = voiceOf(t, v);
  sv.inst = t.p[P_E0] % ADP_INST.length;
  sv.c.ram = ADP_BRR;
  sv.c.start = ADP_INST[sv.inst].start;
  adsr(t, sv);
  sv.c.konDelay = 5;
  sv.c.envMode = SE_ATTACK;
  sv.down = 1;
}

/** The part's DSP samples of this block: the rate counter, the rates firing, the noise at NOISE's rate. */
function block(t: Track): void {
  const d = partOf(t).d;
  const nrate = t.p[P_E3] & 31;
  let k = 0;
  if (!d.init) {
    for (let r = 0; r < 32; r++) d.rc[r] = adpCtr(0, r);
    d.noise = 0x4000;
    d.init = 1;
  }
  d.ein.fill(0);
  d.ph0 = d.ph;
  for (let i = 0; i < CTL; i++) {
    d.ph += ADP_RATE_Q16;
    if (d.ph >= ADP_ONE) {
      let m = 0;
      d.ph -= ADP_ONE;
      for (let r = 1; r < 32; r++) {
        d.rc[r] = d.rc[r] ? d.rc[r] - 1 : ADP_CTR_RATE[r] - 1;
        m |= (d.rc[r] ? 0 : 1) << r;
      }
      m >>>= 0;
      if ((m >>> nrate) & 1) d.noise = adpNoiseStep(d.noise);
      if (k < ADP_TICKS) {
        d.fire[k] = m;
        d.nz[k++] = (d.noise << 16) >> 16;
      }
    }
  }
}

function done(t: Track, v: EngVoice): boolean {
  const sv = voiceOf(t, v);
  return !sv.c.konDelay && !sv.c.env && (sv.c.envMode !== SE_ATTACK || !sv.down);
}

function render(t: Track, v: EngVoice, out: Int32Array, n: number, m: Vmod): void {
  const sv = voiceOf(t, v);
  const d = partOf(t).d;
  const vol = (v.vel + 2) >> ADP_VOL_SH, non = t.p[P_E3] !== 0, eon = t.p[P_E4] !== 0;
  let koff = false, k = 0, ph = d.ph0;
  const pitch = adpPitch(t, sv, m);
  if (n !== CTL) return;
  if (!v.gate && sv.down) {
    const rel = t.p[P_REL];
    sv.down = 0;
    if (!rel) koff = true;
    else {
      sv.c.adsr0 &= 0x7f;
      sv.c.gain = 0xa0 | (31 - Math.floor(((rel - 1) * 30 + 63) / 126));
    }
  } else if (sv.down) {
    adsr(t, sv);
  }
  for (let i = 0; i < n; i++) {
    ph += ADP_RATE_Q16;
    if (ph >= ADP_ONE) {
      ph -= ADP_ONE;
      if (k < ADP_TICKS) {
        sv.o0 = sv.o1;
        sv.o1 = ((adpTick(sv.c, d.fire[k], d.nz[k], pitch, non, koff) * vol) >> 7) << 16 >> 16;
        if (eon) {
          const e = d.ein[k] + sv.o1;
          adpEclips += ((e << 16) >> 16) !== e ? 1 : 0;
          d.ein[k] = adpClamp16(e);
        }
        k++;
        koff = false;
      }
    }
    const s = sv.o0 + (((sv.o1 - sv.o0) * (ph >>> 1)) >> 15);
    out[i] += voiceAmp(s, m, i) << ADP_VOL_SH;
  }
}

function echoClear(a: AdpPart): void {
  const d = a.d;
  a.line.fill(0);
  d.ec = new AdpEcho();
  d.e0 = d.e1 = 0;
  d.quiet = 0;
  d.edirty = 0;
}

function echoFlat(d: AdpDsp): void {
  const x = [d.ec.in, d.ec.wr];
  let moved = false;
  if (x[0] || x[1]) d.edirty = 1;
  for (let k = 0; k < 2; k++) {
    if (!d.quiet) { d.qlo[k] = d.qhi[k] = x[k]; continue; }
    if (x[k] < d.qlo[k]) d.qlo[k] = x[k];
    if (x[k] > d.qhi[k]) d.qhi[k] = x[k];
    moved = moved || d.qhi[k] - d.qlo[k] > 8 || x[k] >= 1024 || x[k] <= -1024;
  }
  if (moved) {
    d.qlo[0] = d.qhi[0] = x[0];
    d.qlo[1] = d.qhi[1] = x[1];
    d.quiet = 1;
  } else if (d.quiet < 0xffff) d.quiet++;
}

/** The part's echo, after its voices; 1 while it still sounds. */
function post(t: Track, out: Int32Array, n: number): number {
  const a = partOf(t);
  const d = a.d;
  const p = t.p;
  const evol = clamp(p[P_E4], 0, 127), efb = clamp(p[P_E6] * 2, -128, 127);
  const fir = ADP_FIRS[p[P_E7] & 3];
  const edl = clamp(p[P_E5], 0, ADP_EDL_MAX);
  let k = 0, any = 0;
  if (n !== CTL) return 0;
  if (!evol) {
    if (d.edirty) echoClear(a);
    return 0;
  }
  for (let i = 0; i < ADP_TICKS; i++) any |= d.ein[i] !== 0 ? 1 : 0;
  if (!any && !d.edirty) return 0;
  let ph = d.ph0;
  for (let i = 0; i < n; i++) {
    ph += ADP_RATE_Q16;
    if (ph >= ADP_ONE) {
      ph -= ADP_ONE;
      if (k < ADP_TICKS) {
        d.e0 = d.e1;
        d.e1 = adpEchoTick(d.ec, a.line, d.ein[k++], evol, efb, fir, edl, true);
        echoFlat(d);
      }
    }
    const s = d.e0 + (((d.e1 - d.e0) * (ph >>> 1)) >> 15);
    out[i] += mulq15(s, VOICE_FS) << ADP_VOL_SH;
  }
  if (d.edirty && d.quiet > d.ec.len + 16) echoClear(a);
  return d.edirty;
}

export const ENG_ADPCM: EngineDef = {
  name: "ADPCM",
  pageTitle: ["VOICE", "ECHO"],
  edit: [
    { label: "INST", fmt: F.ENUM, min: 0, max: ADP_INST.length - 1, def: 0, names: ADP_INST.map((i) => i.name) },
    { label: "TUNE", fmt: F.SEMI, min: -24, max: 24, def: 0 },
    { label: "SR", fmt: F.INT, min: 0, max: 31, def: 0 },
    { label: "NOISE", fmt: F.INT, min: 0, max: 31, def: 0 },
    { label: "ECHO", fmt: F.PCT, min: 0, max: 127, def: 0 },
    { label: "DELAY", fmt: F.ENUM, min: 0, max: ADP_EDL_MAX, def: 4, names: N_ADP_EDL, unit: "ms" },
    { label: "FDBK", fmt: F.BIPCT, min: -64, max: 63, def: 0 },
    { label: "FIR", fmt: F.ENUM, min: 0, max: 3, def: 1, names: N_ADP_FIR },
  ],
  knob: [P_E0, P_E2, P_ATK, P_REL],
  keep: 0,
  sampled: true,
  ownenv: true,
  noteOn,
  render,
  block,
  done,
  post,
};
void P_E7; void P_E5; void P_E6;
