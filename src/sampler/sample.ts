// Port of Felucca's eng_sample.c (GPL-3.0-only): the SAMPLE engine, IMA ADPCM sample sets with zones across the
// keyboard. See NOTICE.
import { clamp, mulq15, softclip, voiceAmp } from "../engines/dsp";
import { EngineDef, EngVoice, F, P_ATK, P_E0, P_E1, P_E2, P_E3, P_E4, P_E6, P_REL, Track, Vmod } from "../engines/types";
import { IMA_IDX, IMA_STEP, pow2q16, SMP_ALL_NAMES, SMP_DATA, SMP_NALL, SMP_NSETS, smpSetMissing, smpSine, usrNz, usrZone, ZONES, Zone } from "./base";
import { SMP_SETS } from "./data";

const zoneOf = (zi: number): Zone => (zi < 0x8000 ? ZONES[zi] : usrZone[(zi >> 5) & 3][zi & 31 & 15]);

/** Next decoded sample; voice: ph[0] position, s[0] predictor, s[1] step index. */
function sampleNext(z: Zone, v: EngVoice, loop: number): number {
  let pos = v.ph[0];
  const b = SMP_DATA[z.off + (pos >>> 1)];
  const code = pos & 1 ? b >> 4 : b & 15;
  const step = IMA_STEP[(v.s[1] >>> 0) <= 88 ? v.s[1] : 88];
  let vd = step >> 3;
  if (code & 4) vd += step;
  if (code & 2) vd += step >> 1;
  if (code & 1) vd += step >> 2;
  v.s[0] = clamp(v.s[0] + (code & 8 ? -vd : vd), -32768, 32767);
  v.s[1] = clamp(v.s[1] + IMA_IDX[code & 7], 0, 88);
  pos++;
  if (pos > z.le && z.looped && loop) {
    pos = z.ls;
    v.s[0] = z.pred;
    v.s[1] = z.idx;
  }
  v.ph[0] = pos;
  return v.s[0];
}

function noteOn(t: Track, v: EngVoice): void {
  const si = t.p[P_E0] % SMP_NALL;
  let zi = 0xffff;
  if (si < SMP_NSETS) {
    const set = SMP_SETS[si];
    for (let i = 0; i < set.nz; i++) {
      const z = ZONES[set.z0 + i];
      if (v.note >= z.lo && v.note <= z.hi) { zi = set.z0 + i; break; }
    }
    v.s[4] = zi === 0xffff ? set.z0 : zi;
  } else { // a user slot: silent if empty; the narrowest zone plays
    const k = si - SMP_NSETS;
    let width = 128;
    for (let i = 0; i < usrNz[k]; i++) {
      const z = usrZone[k][i];
      if (v.note >= z.lo && v.note <= z.hi && z.hi - z.lo <= width) { zi = 0x8000 | (k << 5) | i; width = z.hi - z.lo; }
    }
    v.s[4] = zi === 0xffff ? 0 : zi;
  }
  v.ph[0] = 0;
  v.ph[1] = 0;
  v.s[0] = 0;
  v.s[1] = 0;
  v.s[2] = v.s[3] = 0;
  v.s[6] = zi === 0xffff ? 1 : 0;
  v.s[7] = 0;
  if (smpSetMissing(si)) v.s[6] = 2;
}

function render(t: Track, v: EngVoice, out: Int32Array, n: number, m: Vmod): void {
  const p = t.p;
  const z = zoneOf(v.s[4]);
  let frac = v.ph[1];
  const d16 = clamp(m.pitch16 + p[P_E1] * 16 - z.root16, -1536, 576);
  const r = pow2q16(d16);
  const stepq = Math.imul(r >>> 8, z.rate >>> 8) >>> 0;
  const bits = p[P_E2];
  const lp = 4000 + ((clamp((p[P_E4] << 8) + m.cutoff, 0, 127 << 8) * 28767) >> 15);
  const drv = p[P_E6];
  const sh = Math.trunc(bits / 10);
  if (v.s[6] === 2) {
    const st = { ph: v.ph[0], y: v.s[7] };
    smpSine(out, n, m, p[P_E1] * 16, lp, st);
    v.ph[0] = st.ph;
    v.s[7] = st.y;
    return;
  }
  if (v.s[6] || !z.n) {
    v.active = 0;
    return;
  }
  if (v.ph[0] === 0 && v.ph[1] === 0 && v.s[3] === 0) v.s[3] = sampleNext(z, v, p[P_E3]);
  for (let i = 0; i < n; i++) {
    frac += stepq;
    while (frac >= 65536) {
      frac -= 65536;
      v.s[2] = v.s[3];
      if (v.ph[0] >= z.n) {
        v.s[6] = 1;
        v.s[3] = 0;
        if (frac >= 65536) {
          v.s[2] = 0;
          frac &= 65535;
        }
        break;
      }
      v.s[3] = sampleNext(z, v, p[P_E3]);
    }
    let s = v.s[2] + (Math.imul(v.s[3] - v.s[2], frac >>> 1) >> 15);
    if (sh) s = (s >> sh) << sh;
    if (drv) s = softclip(s + (Math.imul(s >> 2, drv * 150) >> 11));
    v.s[7] += mulq15(s - v.s[7], lp);
    out[i] += voiceAmp(v.s[7], m, i) << 1;
    if (v.s[6]) break;
  }
  v.ph[1] = frac;
}

export const ENG_SAMPLE: EngineDef = {
  name: "SAMPLE",
  pageTitle: ["SET", "TONE"],
  edit: [
    { label: "SET", fmt: F.ENUM, min: 0, max: SMP_NALL - 1, def: 0, names: SMP_ALL_NAMES },
    { label: "TUNE", fmt: F.SEMI, min: -24, max: 24, def: 0 },
    { label: "BITS", fmt: F.INT, min: 0, max: 127, def: 0 },
    { label: "LOOP", fmt: F.ENUM, min: 0, max: 1, def: 1, names: ["OFF", "ON"] },
    { label: "CUT", fmt: F.INT, min: 0, max: 127, def: 127 },
    { label: "-", fmt: F.INT, min: 0, max: 0, def: 0 },
    { label: "DRV", fmt: F.PCT, min: 0, max: 127, def: 0 },
    { label: "-", fmt: F.INT, min: 0, max: 0, def: 0 },
  ],
  knob: [P_E0, P_E4, P_ATK, P_REL],
  keep: 0,
  sampled: true,
  noteOn,
  render,
};
