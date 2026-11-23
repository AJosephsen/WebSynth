// Port of Felucca's eng_slice.c (GPL-3.0-only): the SLICE engine, a sample slicer over the built-in drum break
// and a piano note (the user slots and hand-set MAN slices are not part of this port). See NOTICE.
import { clamp, mulq15, mulq16, voiceAmp } from "../engines/dsp";
import { ENV_EXP } from "../engines/felucca-tables";
import { EngineDef, EngVoice, F, P_E0, P_E1, P_E2, P_E3, P_E4, P_E5, P_E6, P_E7, P_ROOT, Track, Vmod } from "../engines/types";
import { IMA_IDX, IMA_STEP, onUserScan, pow2q16, SMP_DATA, SMP_USER_SLOTS, smpSine, usrNz, usrZone } from "./base";
import { SLC_BREAK, SLC_PIANO } from "./data";

const GRID = 128, GRID_LOG2 = 7, RB = 64, BASE = 60;
const SRC_PIANO = 4, NSRC = 5, SINE = 7;
const ONE = 0, LOOP = 2;
const DIV_AUTO = 4;

interface Src { len: number; rate: number; nseg: number; nauto: number; seg: { off: number; at: number; n: number }[]; grid: number[]; apos: number[]; ast: number[] }
const usr: Src[] = Array.from({ length: SMP_USER_SLOTS }, () => ({ len: 0, rate: 0, nseg: 0, nauto: 0, seg: [], grid: [], apos: [], ast: [] }));
const get = (src: number): Src | null => {
  if (src === 0) return SLC_BREAK.len ? SLC_BREAK : null;
  if (src === SRC_PIANO) return SLC_PIANO.len ? SLC_PIANO : null;
  const k = src - 1;
  return k >= 0 && k < SMP_USER_SLOTS && usrNz[k] && usr[k].len ? usr[k] : null;
};

class Dec { pred = 0; idx = 0; pos = 0; seg = 0; }
function decAt(d: Dec, pos: number, st: number): void {
  d.pos = pos;
  d.pred = (st << 16) >> 16;
  d.idx = (st >>> 16) & 127;
  d.seg = st >>> 24;
}
const decSt = (d: Dec): number => (((d.pred & 0xffff) | (d.idx << 16) | (d.seg << 24)) >>> 0);

function decNext(s: Src, d: Dec): number {
  let g = s.seg[d.seg];
  let rel = d.pos - g.at;
  if (rel >= g.n && d.seg + 1 < s.nseg) {
    d.seg++;
    g = s.seg[d.seg];
    rel = d.pos - g.at;
    d.pred = 0;
    d.idx = 0;
  }
  const b = SMP_DATA[g.off + (rel >>> 1)];
  const code = rel & 1 ? b >> 4 : b & 15;
  const step = IMA_STEP[d.idx];
  let vd = step >> 3;
  if (code & 4) vd += step;
  if (code & 2) vd += step >> 1;
  if (code & 1) vd += step >> 2;
  d.pred = clamp(d.pred + (code & 8 ? -vd : vd), -32768, 32767);
  d.idx = clamp(d.idx + IMA_IDX[code & 7], 0, 88);
  d.pos++;
  return d.pred;
}

const gpos = (s: Src, k: number): number => (k * s.len) >>> GRID_LOG2;
const count = (s: Src, div: number): number => (div < DIV_AUTO ? 4 << div : s.nauto);

function noteSlice(p: Int16Array, note: number, n: number): number {
  const j = (note - BASE - p[P_ROOT] + p[P_E2]) % n;
  return j < 0 ? j + n : j;
}

function bounds(s: Src, div: number, j: number): [number, number, number] {
  if (div < DIV_AUTO) {
    const w = GRID >> (2 + div);
    return [gpos(s, j * w), gpos(s, (j + 1) * w), s.grid[j * w]];
  }
  j = j < s.nauto ? j : s.nauto - 1;
  return [s.apos[j], j + 1 < s.nauto ? s.apos[j + 1] : s.len, s.ast[j]];
}
const boundsV = (s: Src, v: EngVoice): [number, number, number] => {
  const pk = v.s[4] >>> 0;
  return bounds(s, (pk >>> 16) & 7, (pk >>> 8) & 63);
};

const rbufs = new WeakMap<EngVoice, Int16Array>();
const rbOf = (v: EngVoice): Int16Array => {
  let b = rbufs.get(v);
  if (!b) { b = new Int16Array(RB); rbufs.set(v, b); }
  return b;
};

function noteOn(t: Track, v: EngVoice): void {
  const p = t.p;
  const src = clamp(p[P_E0], 0, NSRC - 1);
  const div = clamp(p[P_E1], 0, 5);
  const rev = p[P_E5] !== 0 ? 1 : 0;
  const s = get(src);
  v.ph[1] = 0;
  v.s[2] = v.s[3] = 0;
  v.s[5] = 32767;
  v.s[6] = 2;
  v.s[7] = 0;
  v.envOut = 0;
  if (!s) {
    v.s[4] = SINE;
    v.s[6] = 1;
    v.ph[0] = 0;
    return;
  }
  const j = noteSlice(p, v.note, count(s, div));
  const [a, b, st] = bounds(s, div, j);
  if (b <= a) return;
  v.s[4] = (src | ((st >>> 24) << 3) | (rev << 7) | (j << 8) | (div << 16)) | 0;
  v.s[6] = 0;
  if (rev) {
    v.ph[0] = b;
    v.ph[2] = a;
    v.s[0] = 0x7fffffff;
  } else {
    v.ph[0] = a;
    v.ph[2] = b;
    v.s[0] = (st << 16) >> 16;
    v.s[1] = (st >>> 16) & 127;
  }
}

function fill(s: Src, rb: Int16Array, ws: number, n: number, a: number, sa: number): void {
  const d = new Dec();
  let k = Math.floor((ws * 128) / s.len);
  while (k + 1 < GRID && gpos(s, k + 1) <= ws) k++;
  if (a <= ws && a > gpos(s, k)) decAt(d, a, sa);
  else decAt(d, gpos(s, k), s.grid[k]);
  while (d.pos < ws) decNext(s, d);
  for (let i = 0; i < n; i++) rb[i] = decNext(s, d);
}

function fwd(s: Src, v: EngVoice, d: Dec, loop: boolean, out: { x: number }): boolean {
  if (d.pos >= v.ph[2]) {
    if (!loop) return false;
    const [a, b, st] = boundsV(s, v);
    decAt(d, a, st);
    v.ph[2] = b;
  }
  out.x = decNext(s, d);
  return true;
}

function rev(s: Src, v: EngVoice, rb: Int16Array, loop: boolean, out: { x: number }): boolean {
  let q = v.ph[0];
  let ws = v.s[0] >>> 0;
  if (q <= v.ph[2]) {
    if (!loop) return false;
    const [a, b] = boundsV(s, v);
    q = b;
    v.ph[2] = a;
  }
  q--;
  if (q < ws || q >= ws + RB) {
    const [a, , st] = boundsV(s, v);
    if (q < a) return false;
    ws = q + 1 >= a + RB ? q + 1 - RB : a;
    fill(s, rb, ws, q + 1 - ws, a, st);
    v.s[0] = ws;
  }
  out.x = rb[q - ws];
  v.ph[0] = q;
  return true;
}

function amp(t: Track, v: EngVoice, adsr: number): number {
  const p = t.p;
  if (p[P_E4] === ONE && v.stage === 3 && (v.s[4] & 7) !== SINE) v.stage = 2;
  if (p[P_E6] < 127) {
    v.s[5] -= mulq16(v.s[5], ENV_EXP[p[P_E6] & 127]);
    if (v.s[5] < 8) v.s[6] = 2;
  }
  return v.s[6] === 3 ? 0 : mulq15(adsr, v.s[5]);
}

const xo = { x: 0 };

function render(t: Track, v: EngVoice, out: Int32Array, n: number, m: Vmod): void {
  const p = t.p;
  const pk = v.s[4] >>> 0;
  let frac = v.ph[1];
  const isRev = (pk >>> 7) & 1;
  const lp = 4000 + ((clamp((p[P_E7] << 8) + m.cutoff, 0, 127 << 8) * 28767) >> 15);
  const loop = p[P_E4] === LOOP && !!v.gate;
  const s = v.s[6] === 2 || (pk & 7) === SINE ? null : get(pk & 7);
  const rb = rbOf(v);
  if ((pk & 7) === SINE && v.s[6] !== 2) {
    const st = { ph: v.ph[0], y: v.s[7] };
    smpSine(out, n, m, p[P_E3] * 16, lp, st);
    v.ph[0] = st.ph;
    v.s[7] = st.y;
    return;
  }
  if (!s) {
    v.active = 0;
    return;
  }
  const stepq = Math.imul(pow2q16(clamp(m.pitch16 - v.pitchCur + p[P_E3] * 16, -1536, 576)) >>> 8, s.rate >>> 8) >>> 0;
  const d = new Dec();
  d.pos = v.ph[0];
  d.pred = v.s[0];
  d.idx = v.s[1];
  d.seg = (pk >>> 3) & 15;
  if (!v.s[6]) {
    if (!(isRev ? rev(s, v, rb, false, xo) : fwd(s, v, d, false, xo))) {
      v.active = 0;
      return;
    }
    v.s[3] = xo.x;
    v.s[6] = 1;
  }
  const rem = ((isRev ? v.ph[0] - v.ph[2] : v.ph[2] - d.pos) >>> 0);
  if (v.s[6] === 1 && !loop && rem < Math.floor((stepq * 3 * n) / 65536)) v.s[6] = 3;
  for (let i = 0; i < n; i++) {
    frac += stepq;
    while (frac >= 65536) {
      frac -= 65536;
      v.s[2] = v.s[3];
      if (!(isRev ? rev(s, v, rb, loop, xo) : fwd(s, v, d, loop, xo))) {
        v.s[6] = 2;
        v.s[3] = 0;
        break;
      }
      v.s[3] = xo.x;
    }
    const y = v.s[2] + (Math.imul(v.s[3] - v.s[2], frac >>> 1) >> 15);
    v.s[7] += mulq15(y - v.s[7], lp);
    out[i] += voiceAmp(v.s[7], m, i) << 1;
    if (v.s[6] === 2) break;
  }
  v.ph[1] = frac;
  if (!isRev) {
    v.ph[0] = d.pos;
    v.s[0] = d.pred;
    v.s[1] = d.idx;
    v.s[4] = ((pk & ~(15 << 3)) | (d.seg << 3)) | 0;
  }
}

export const ENG_SLICE: EngineDef = {
  name: "SLICE",
  pageTitle: ["SLCE", "PLAY"],
  edit: [
    { label: "SRC", fmt: F.ENUM, min: 0, max: NSRC - 1, def: 0, names: ["BREAK", "USR1", "USR2", "USR3", "PIANO"] },
    { label: "DIV", fmt: F.ENUM, min: 0, max: 5, def: 2, names: ["4", "8", "16", "32", "AUTO", "MAN"] },
    { label: "START", fmt: F.INT, min: 0, max: 31, def: 0 },
    { label: "PTCH", fmt: F.SEMI, min: -24, max: 24, def: 0 },
    { label: "MODE", fmt: F.ENUM, min: 0, max: 2, def: 0, names: ["ONE", "GATE", "LOOP"] },
    { label: "REV", fmt: F.ENUM, min: 0, max: 1, def: 0, names: ["OFF", "ON"] },
    { label: "DCAY", fmt: F.TIME, min: 0, max: 127, def: 127 },
    { label: "TONE", fmt: F.INT, min: 0, max: 127, def: 127 },
  ],
  knob: [P_E0, P_E1, P_E3, P_E6],
  keep: 0,
  sampled: true,
  noteOn,
  render,
  amp,
};

// ---- the slice table of a user slot (eng_slice.c slc_user_scan / slc_scan): two decoding passes, grid states and AUTO onsets ----
const SEGS = 16, AUTO = 32, HOP = 32;
const USR_MAX = 2 * (0x14000 - 512);

function scan(s: Src, len: number): void {
  const d = new Dec();
  let pos = 0, k = 0, last = 0, h0 = 0, st0 = 0;
  const gap = Math.floor((Math.imul(s.rate >>> 4, 44100) >>> 12) / 20);
  let prev = 0, pkd = 0, pkr = 0, envd = 0, envr = 0;
  decAt(d, 0, 0);
  while (pos++ < len) {
    const x = decNext(s, d);
    let a = x - prev;
    a = a < 0 ? -a : a;
    pkd = a > pkd ? a : pkd;
    a = x < 0 ? -x : x;
    pkr = a > pkr ? a : pkr;
    prev = x;
  }
  const thd = Math.trunc(pkd / 12), thr = Math.trunc(pkr / 8);
  s.nauto = 1;
  s.apos = [0];
  s.ast = [0];
  s.grid = new Array(GRID).fill(0);
  decAt(d, 0, 0);
  prev = 0;
  for (pos = 0; pos < len;) {
    const hs = pos, hst = decSt(d), e = len - pos > HOP ? pos + HOP : len;
    let hd = 0, hr = 0;
    for (; pos < e; pos++) {
      while (k < GRID && (Math.floor((k * len) / 128)) === pos) s.grid[k++] = decSt(d);
      const x = decNext(s, d);
      let a = x - prev;
      a = a < 0 ? -a : a;
      hd = a > hd ? a : hd;
      a = x < 0 ? -x : x;
      hr = a > hr ? a : hr;
      prev = x;
    }
    if (hs && ((hd > thd && hd * 4 > envd * 7) || (hr > thr && hr * 4 > envr * 7)) && h0 >= last + gap && s.nauto < AUTO) {
      s.apos[s.nauto] = h0;
      s.ast[s.nauto++] = st0;
      last = h0;
    }
    envd = hd > envd ? hd : envd - Math.trunc(envd / 16);
    envr = hr > envr ? hr : envr - Math.trunc(envr / 64);
    h0 = hs;
    st0 = hst;
  }
}

onUserScan((k, valid) => {
  const s = usr[k];
  s.len = 0;
  if (!valid) return;
  s.nseg = 0;
  s.seg = [];
  let at = 0;
  for (let i = 0; i < usrNz[k] && i < SEGS; i++) {
    const z = usrZone[k][i];
    let j = 0;
    while (j < i && usrZone[k][j].off !== z.off) j++;
    if (j < i || !z.n) continue;
    if (z.n > USR_MAX - at) break;
    s.seg.push({ off: z.off, at, n: z.n });
    s.nseg++;
    at += z.n;
  }
  if (!s.nseg) return;
  s.rate = usrZone[k][0].rate;
  scan(s, at);
  s.len = at;
});
