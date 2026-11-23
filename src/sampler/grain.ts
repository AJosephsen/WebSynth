// Port of Felucca's eng_grain.c (GPL-3.0-only): the GRAIN engine, granular synthesis over the SAMPLE material.
// See NOTICE.
import { clamp, mulq15, noiseStep, voiceAmp } from "../engines/dsp";
import { CTL, EngineDef, EngVoice, F, P_E0, P_E1, P_E2, P_E3, P_E4, P_E5, P_E6, P_E7, Track, Vmod } from "../engines/types";
import { IMA_IDX, IMA_STEP, pow2q16, SMP_ALL_NAMES, SMP_DATA, SMP_NALL, SMP_NSETS, smpSetMissing, smpSine, ZONES, Zone } from "./base";
import { SMP_SETS } from "./data";
import { GR_HANN, GR_NORM } from "./grain-tables";

const GR_POLY = 3, GR_NG = 12, GR_SEG_LOG2 = 8, GR_SEG = 1 << 8, GR_NIDX = 1024, GR_MAXZ = 32, GR_RB = 128;
const GR_STEP_MAX = 2 << 16, GR_LOAD_MAX = 8 << 16;
const GR_SINE = -2;

class St { pred = 0; idx = 0; }

class Grain {
  z: Zone | null = null;
  pos = 0; frac = 0; step = 0; wph = 0; winc = 0; left = 0;
  a = 0; b = 0; pred = 0; idx = 0; rlo = 0; gain = 0; owner = 0; rev = 0; zl = 0;
}

class Part {
  g = Array.from({ length: GR_NG }, () => new Grain());
  rb = Array.from({ length: GR_NG }, () => new Int16Array(GR_RB));
  ipred = new Int16Array(GR_NIDX);
  iidx = new Uint8Array(GR_NIDX);
  zbase = new Uint16Array(GR_MAXZ); zcnt = new Uint16Array(GR_MAXZ); zdone = new Uint16Array(GR_MAXZ);
  stamp = 0; src = 0; nz = 0;
  rng = 0;
}

const parts = new WeakMap<Track, Part>();
function partOf(t: Track): Part {
  let p = parts.get(t);
  if (!p) { p = new Part(); parts.set(t, p); }
  return p;
}

const gnz = (src: number): number => (src < SMP_NSETS ? SMP_SETS[src].nz : 0);
const gzone = (src: number, zl: number): Zone => ZONES[SMP_SETS[src].z0 + zl];
const gstamp = (src: number): number => (src < SMP_NSETS ? 0 : 0xffffffff);
const gscale = (n: number, f16: number): number => (n >>> 16) * f16 + (((n & 0xffff) * f16) >>> 16);

function dec(z: Zone, pos: number, st: St): number {
  const b = SMP_DATA[z.off + (pos >>> 1)];
  const code = pos & 1 ? b >> 4 : b & 15;
  const step = IMA_STEP[st.idx];
  let vd = step >> 3;
  if (code & 4) vd += step;
  if (code & 2) vd += step >> 1;
  if (code & 1) vd += step >> 2;
  st.pred = clamp(st.pred + (code & 8 ? -vd : vd), -32768, 32767);
  st.idx = clamp(st.idx + IMA_IDX[code & 7], 0, 88);
  return st.pred;
}

function find(src: number, note: number): number {
  const nz = gnz(src);
  let zl = src < SMP_NSETS ? 0 : -1;
  if (smpSetMissing(src)) return GR_SINE;
  for (let i = 0; i < nz && i < GR_MAXZ; i++) {
    const z = gzone(src, i);
    if (note >= z.lo && note <= z.hi) zl = i;
  }
  return zl;
}

function reset(P: Part, src: number, stamp: number): void {
  let tot = 0;
  const nz = gnz(src);
  P.src = src + 1;
  P.stamp = stamp;
  P.nz = nz < GR_MAXZ ? nz : GR_MAXZ;
  for (const g of P.g) g.owner = 0;
  for (let i = 0; i < P.nz; i++) {
    let c = (gzone(src, i).n + GR_SEG - 1) >>> GR_SEG_LOG2;
    if (tot + c > GR_NIDX) c = 0;
    P.zbase[i] = tot;
    P.zcnt[i] = c;
    P.zdone[i] = c ? 1 : 0;
    if (c) { P.ipred[tot] = 0; P.iidx[tot] = 0; }
    tot += c;
  }
}

const bst = new St();

function build(P: Part, t: Track): void {
  let zl = GR_MAXZ;
  for (let i = 0; i < GR_POLY && zl === GR_MAXZ; i++) {
    const v = t.v[i];
    if (!v) break;
    const vz = v.s[0];
    if (v.active && vz >= 0 && vz < P.nz && P.zdone[vz] < P.zcnt[vz]) zl = vz;
  }
  for (let i = 0; i < P.nz && zl === GR_MAXZ; i++) if (P.zdone[i] < P.zcnt[i]) zl = i;
  if (zl === GR_MAXZ) return;
  const z = gzone(P.src - 1, zl);
  const k = P.zdone[zl];
  const e = P.zbase[zl] + k - 1;
  bst.pred = P.ipred[e];
  bst.idx = P.iidx[e];
  const pos = (k - 1) << GR_SEG_LOG2;
  for (let i = 0; i < GR_SEG; i++) dec(z, pos + i, bst);
  P.ipred[e + 1] = bst.pred;
  P.iidx[e + 1] = bst.idx;
  P.zdone[zl] = k + 1;
}

function seek(P: Part, z: Zone, zl: number, p: number, st: St): void {
  const e = P.zbase[zl] + (p >>> GR_SEG_LOG2);
  st.pred = P.ipred[e];
  st.idx = P.iidx[e];
  for (let q = p & ~(GR_SEG - 1); q < p; q++) dec(z, q, st);
}

const fst = new St();

function fill(P: Part, g: Grain, rb: Int16Array, zl: number, hi: number): void {
  const lo = hi >= GR_RB - 1 ? hi - (GR_RB - 1) : 0;
  seek(P, g.z!, zl, lo, fst);
  for (let q = lo; q <= hi; q++) rb[q - lo] = dec(g.z!, q, fst);
  g.rlo = lo;
}

function rnd(P: Part): number {
  P.rng = noiseStep(P.rng);
  return P.rng >>> 0;
}

const sst = new St();

function spawn(P: Part, t: Track, vi: number, zl: number, iv: number, m: Vmod): void {
  const p = t.p;
  const z = gzone(P.src - 1, zl);
  let g: Grain | null = null;
  let gi = -1;
  const n = z.n;
  const r1 = rnd(P), r2 = rnd(P);
  for (let i = 0; i < GR_NG && !g; i++) if (!P.g[i].owner) { g = P.g[i]; gi = i; }
  if (!g || n < 8 || !P.zcnt[zl]) return;
  let len = Math.floor((441 * pow2q16(p[P_E2] * 8)) / 65536);
  const amt = Math.trunc((p[P_E6] * p[P_E6] * 192) / (127 * 127));
  const d16 = m.pitch16 - z.root16 + p[P_E4] * 16 + ((((r1 & 0xffff) - 32768) * amt) >> 15);
  let step = Math.imul(pow2q16(clamp(d16, -1536, 576)) >>> 8, z.rate >>> 8) >>> 0;
  step = step > GR_STEP_MAX ? GR_STEP_MAX : step < 256 ? 256 : step;
  const rev = ((r1 >>> 16) & 255) < p[P_E6] ? 1 : 0;
  let span = Math.floor((len * step) / 65536);
  if (span + 3 > n) {
    span = n - 3;
    len = Math.floor((span * 256) / (step >>> 8));
  }
  if (len < 16) return;
  const posq = clamp((p[P_E1] << 8) + m.shape - (64 << 8), 0, 127 << 8);
  let c = gscale(n - 1, Math.floor((posq * 65535) / (127 << 8)));
  const sp = gscale(n, p[P_E5] * 516);
  let pos = c + gscale(sp, r2 & 0xffff) - (sp >>> 1);
  if (rev) pos = clamp(pos, span, n - 2);
  else pos = clamp(pos, 0, n - 3 - span);
  if (pos >>> GR_SEG_LOG2 >= P.zdone[zl]) return;
  c = (step << rev) >>> 0;
  for (let i = 0; i < GR_NG; i++) if (P.g[i].owner) c += (P.g[i].step << P.g[i].rev) >>> 0;
  if (c > GR_LOAD_MAX) return;
  g.z = z;
  g.step = step;
  g.frac = 0;
  g.wph = 0;
  g.winc = Math.floor(0xffffffff / len);
  g.left = len;
  g.rev = rev;
  g.zl = zl;
  const ov = Math.floor(len / (iv || 1));
  g.gain = GR_NORM[ov < 1 ? 1 : ov > GR_NG ? GR_NG : ov];
  g.owner = vi + 1;
  if (rev) {
    const rb = P.rb[gi];
    g.pos = pos;
    fill(P, g, rb, zl, pos + 1);
    g.a = rb[g.pos - g.rlo];
    g.b = rb[g.pos + 1 - g.rlo];
  } else {
    seek(P, z, zl, pos, sst);
    g.a = dec(z, pos, sst);
    g.b = dec(z, pos + 1, sst);
    g.pred = sst.pred;
    g.idx = sst.idx;
    g.pos = pos + 2;
  }
}

function win(wph: number): number {
  const wi = wph >>> 24;
  return GR_HANN[wi] + (Math.imul(GR_HANN[wi + 1] - GR_HANN[wi], (wph >>> 9) & 0x7fff) >> 15);
}

const rst = new St();

function run(P: Part, gi: number, acc: Int32Array, n: number): boolean {
  const g = P.g[gi];
  const m = n < g.left ? n : g.left;
  const step = g.step;
  let pos = g.pos;
  let a = g.a, b = g.b, frac = g.frac;
  const z = g.z!;
  const w0 = mulq15(win(g.wph), g.gain);
  g.wph = (g.wph + Math.imul(g.winc, m)) >>> 0;
  g.left -= m;
  const w1 = g.left ? mulq15(win(g.wph), g.gain) : 0;
  let wq = w0 * 1024;
  const dq = m === CTL ? ((w1 - w0) * 1024) >> 5 : m ? Math.trunc(((w1 - w0) * 1024) / m) : 0;
  if (!g.rev) {
    rst.pred = g.pred;
    rst.idx = g.idx;
    for (let i = 0; i < m; i++) {
      const s = a + (Math.imul(b - a, frac >> 1) >> 15);
      acc[i] += Math.imul(s, wq >> 10) >> 15;
      wq += dq;
      frac += step;
      while (frac >= 65536) {
        frac -= 65536;
        a = b;
        b = pos < z.n ? dec(z, pos++, rst) : a;
      }
    }
    g.pred = rst.pred;
    g.idx = rst.idx;
  } else {
    const rb = P.rb[gi];
    for (let i = 0; i < m; i++) {
      const s = a + (Math.imul(b - a, frac >> 1) >> 15);
      acc[i] += Math.imul(s, wq >> 10) >> 15;
      wq += dq;
      frac -= step;
      while (frac < 0) {
        frac += 65536;
        b = a;
        if (pos) {
          pos--;
          if (pos < g.rlo) fill(P, g, rb, g.zl, pos);
        }
        a = rb[pos - g.rlo];
      }
    }
  }
  g.pos = pos;
  g.a = a;
  g.b = b;
  g.frac = frac;
  if (!g.left) g.owner = 0;
  return g.left !== 0;
}

function noteOn(t: Track, v: EngVoice): void {
  const P = partOf(t);
  const vi = t.v.indexOf(v);
  v.s[0] = find(t.p[P_E0] % SMP_NALL, v.note);
  v.s[1] = 0;
  v.ph[0] = 0;
  if (!v.env) {
    for (const g of P.g) if (g.owner === vi + 1) g.owner = 0;
    v.s[2] = 0;
  }
}

function block(t: Track): void {
  const P = partOf(t);
  const src = t.p[P_E0] % SMP_NALL;
  const st = gstamp(src);
  if (!P.rng) P.rng = 0x2545f491;
  if (P.src !== src + 1 || P.stamp !== st) {
    reset(P, src, st);
    for (const v of t.v) if (v.active) v.s[0] = find(src, v.note);
  }
  for (const g of P.g) {
    if (g.owner && !t.v[(g.owner - 1) % t.v.length]?.active) g.owner = 0;
  }
  build(P, t);
}

const acc = new Int32Array(CTL);

function render(t: Track, v: EngVoice, out: Int32Array, n: number, m: Vmod): void {
  const P = partOf(t);
  const p = t.p;
  const vi = t.v.indexOf(v);
  let mine = 0, nact = 0;
  const zl = v.s[0];
  let y = v.s[2];
  if (n > CTL) n = CTL;
  if (zl === GR_SINE) {
    const lp0 = 4000 + ((clamp((p[P_E7] << 8) + m.cutoff, 0, 127 << 8) * 28767) >> 15);
    const st = { ph: v.ph[0], y: v.s[2] };
    smpSine(out, n, m, p[P_E4] * 16, lp0, st);
    v.ph[0] = st.ph;
    v.s[2] = st.y;
    return;
  }
  if (zl < 0 || zl >= P.nz || P.src !== (p[P_E0] % SMP_NALL) + 1) {
    if (zl < 0) v.active = 0;
    return;
  }
  acc.fill(0, 0, n);
  for (let i = 0; i < GR_POLY; i++) if (t.v[i]?.active) nact++;
  for (let i = 0; i < GR_NG; i++) if (P.g[i].owner === vi + 1 && run(P, i, acc, n)) mine++;
  const iv = Math.floor((44100 * pow2q16(-p[P_E3] * 10)) / 65536);
  v.s[1] -= n;
  if (v.s[1] <= 0) {
    const r = rnd(P);
    const j = Math.trunc(Math.imul((r & 0xffff) - 32768, p[P_E5]) / 254);
    v.s[1] += iv + mulq15(iv, j);
    if (v.s[1] < 0) v.s[1] = 0;
    if (mine < (nact > 1 ? (Math.floor(GR_NG / nact) > 2 ? Math.floor(GR_NG / nact) : 2) : GR_NG)) spawn(P, t, vi, zl, iv, m);
  }
  const lp = 4000 + ((clamp((p[P_E7] << 8) + m.cutoff, 0, 127 << 8) * 28767) >> 15);
  for (let i = 0; i < n; i++) {
    y += mulq15(clamp(acc[i], -65535, 65535) - y, lp);
    out[i] += voiceAmp(y, m, i) << 1;
  }
  v.s[2] = y;
}

export const ENG_GRAIN: EngineDef = {
  name: "GRAIN",
  pageTitle: ["GRAN", "SPRY"],
  edit: [
    { label: "SRC", fmt: F.ENUM, min: 0, max: SMP_NALL - 1, def: 0, names: SMP_ALL_NAMES },
    { label: "POS", fmt: F.PCT, min: 0, max: 127, def: 32 },
    { label: "SIZE", fmt: F.PCT, min: 0, max: 127, def: 80 },
    { label: "DENS", fmt: F.PCT, min: 0, max: 127, def: 80 },
    { label: "PTCH", fmt: F.SEMI, min: -24, max: 24, def: 0 },
    { label: "SPRD", fmt: F.PCT, min: 0, max: 127, def: 30 },
    { label: "RAND", fmt: F.PCT, min: 0, max: 127, def: 10 },
    { label: "TONE", fmt: F.PCT, min: 0, max: 127, def: 127 },
  ],
  knob: [P_E1, P_E2, P_E3, P_E5],
  keep: 0,
  poly: GR_POLY,
  noteOn,
  render,
  block,
};
void SMP_NSETS;
