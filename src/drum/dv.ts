// Port of Felucca's drum_voice.c (GPL-3.0-only): lean fixed-point drum voices for a kit of 8 lanes. See NOTICE.
// C int32 arithmetic is reproduced with Math.imul / >> ; uint32 with >>> 0.
import { clamp, mulq16, noiseStep, pitchInc, sineI, softclip, Tsvf } from "../engines/dsp";
import { CTL } from "../engines/types";
import { DV_DEF, DV_KIT, DV_KIT_ACC, DV_METAL_R } from "./data";

export const DV_KICK = 0, DV_SNARE = 1, DV_CLAP = 2, DV_HATC = 3, DV_HATO = 4, DV_TOM = 5, DV_RIM = 6, DV_BELL = 7, DV_NLANE = 8;
export const DVT_PUNCH = 0, DVT_ROUND = 1, DVT_SNARE = 2, DVT_CLAP = 3, DVT_HATC = 4, DVT_HATO = 5, DVT_TOM = 6, DVT_CONGA = 7,
  DVT_RIM = 8, DVT_CLAVE = 9, DVT_BELL = 10, DVT_CYM = 11, DVT_COUNT = 12;
export const DV_NKIT = 8;
export const DV_KITOF = (t: number): number => t >> 4;
export const DV_KTYPE = (kit: number, lane: number): number => ((kit << 4) | lane) & 0xff;

export interface DvParam {
  type: number; // DVT_*, or a model kit's (DV_KTYPE)
  decay: number; tone: number; extra: number; level: number; accent: number; // 0..127
  tune: number; // 1/16 semitone from the designed pitch
}

export class DvCoef {
  inc = new Uint32Array(3);
  span = new Uint32Array(2);
  k = new Uint32Array(3);
  kb = new Uint32Array(2);
  g = new Int32Array(6);
  f = [new Tsvf(), new Tsvf()];
  hp = 0;
  out = 0;
  hold = 0; click = 0;
  type = 0; mrow = 0;
  metal = 0;
  clear(): void {
    this.inc.fill(0); this.span.fill(0); this.k.fill(0); this.kb.fill(0); this.g.fill(0);
    for (const f of this.f) { f.a1 = f.a2 = f.a3 = 0; }
    this.hp = this.out = this.hold = this.click = this.type = this.mrow = this.metal = 0;
  }
}

export class DvVoice {
  type = 0; trig = 0; choke = 0; live = 0;
  n = 0; cnt = 0;
  ph = new Uint32Array(3);
  e = new Uint32Array(3);
  q = new Int32Array(2);
  s = new Int32Array(5);
  rng = 0;
}

export class DvMetal {
  ph = new Uint32Array(6);
  inc = new Uint32Array(6);
}

const DV_SEED = 0x5eed1234;
const P16 = (p: number): number => pitchInc(clamp(p, 0, 2047));
const QUIET = 1 << 16;
const u15 = (a: number, b: number): number => Math.imul(a, b) >>> 15; // uint32 product, >> 15

function dvExp2(x: number): number {
  const f = x & 4095;
  const m = 65536 + (Math.floor((f * (45594 + Math.floor((f * (14851 + Math.floor((f * 5092) / 4096))) / 4096))) / 4096));
  return m * 2 ** (x >>> 12);
}
function dvK(us: number): number {
  const x = Math.floor(743039 / (us | 1));
  return x >= 32768 ? 0 : 32768 - x + Math.floor((x * x) / 65536);
}
function dvKb(us: number): number {
  let x = Math.floor(47554467 / (us | 1));
  if (x > 46000) x = 46000;
  const x2 = Math.floor((x * x) / 65536);
  const x3 = Math.floor((x2 * x) / 65536);
  const x4 = Math.floor((x3 * x) / 65536);
  const k = 65536 - x + (x2 >>> 1) - Math.floor(x3 / 6) + Math.floor(x4 / 24);
  return k > 65535 ? 65535 : k;
}
function dvTauOf(tau0: number, oct16: number, d: number): number {
  const m = dvExp2(Math.floor((d * oct16 * 4096) / (127 * 16)));
  return (tau0 * ((m * 100) >>> 12)) >>> 4;
}
const dvTau = (type: number, d: number): number => dvTauOf(DV_DEF[type].tau0, DV_DEF[type].oct16, d);
const dvCut = (p16: number): number => clamp(((p16 - 360) * 4785) >> 8, 0, 127 << 8);
function dvPole(p16: number): number {
  const w = Math.floor(((P16(p16) >>> 17) * 205887) / 32768);
  return Math.trunc((w << 15) / (32768 + w));
}
function dvHp1(p16: number): [number, number] {
  const inc = p16 > 1900 ? (P16(clamp(p16, 0, 2239) - 192) << 1) >>> 0 : P16(p16);
  const u = Math.floor(((inc >>> 17) * 205887) / 32768);
  return [Math.trunc((65536 << 14) / (65536 + u)), Math.trunc(Math.imul(65536 - u, 16384) / (65536 + u))];
}
const dvLin = (v: number, lo: number, hi: number): number => lo + Math.trunc(Math.imul(hi - lo, v) / 127);

function setupOwn(c: DvCoef, p: DvParam): void {
  const t = p.type < DVT_COUNT ? p.type : 0;
  const d = p.decay, tn = p.tone, x = p.extra;
  const def = DV_DEF[t];
  const p16 = clamp(def.p16 + p.tune, def.lo, def.hi);
  const acc = p.accent;
  const tau = dvTau(t, d);
  c.clear();
  c.type = t;
  c.mrow = t === DVT_CYM ? 1 : 0;
  c.inc[0] = P16(p16);
  c.metal = p16;
  c.out = Math.floor((def.gain * p.level) / 127);
  c.out += (c.out * acc * 75) >> 14;
  switch (t) {
    case DVT_PUNCH:
    case DVT_ROUND: {
      const punch = t === DVT_PUNCH;
      const b = punch ? Math.trunc((tn * 576) / 127) : Math.trunc((tn * 192) / 127);
      const a = punch ? 384 : 0;
      c.span[1] = P16(p16 + b) - c.inc[0];
      c.span[0] = P16(p16 + a + b) - P16(p16 + b);
      c.k[0] = dvK(1500);
      c.k[1] = dvK(punch ? 8000 + Math.floor((tn * 32000) / 127) : 30000 + Math.floor((tn * 30000) / 127));
      c.kb[0] = dvKb(tau);
      c.hold = punch ? 17 : 0;
      c.g[0] = punch ? 2300 : 6500;
      c.g[1] = punch ? 1300 : 9800;
      c.inc[1] = P16(punch ? 1636 : 1523);
      c.inc[2] = c.inc[1] >>> 1;
      c.click = Math.floor(0xffffffff / c.inc[2]) & 0xffff;
      c.g[2] = (punch ? 9000 : 5000) + acc * 24;
      const g = 4096 + Math.trunc((x * 3 * 4096) / 127);
      c.g[3] = g;
      c.g[4] = Math.floor((19661 * 32768) / softclip((19661 * g) >> 12));
      break;
    }
    case DVT_SNARE:
      c.click = 154;
      c.span[0] = P16(p16 + 11) - c.inc[0];
      c.k[0] = dvK(20000);
      c.k[1] = dvK(Math.floor((tau * 2) / 5));
      c.k[2] = dvK(3000);
      c.kb[0] = dvKb(tau);
      c.f[0].setK(dvCut(1715 + Math.trunc((tn * 160) / 127) - 80), 5120);
      c.hp = dvPole(1777);
      c.g[0] = 19000;
      c.g[1] = Math.trunc((dvLin(tn, 8192, 16384) * 3) / 2);
      c.g[2] = Math.trunc((x * 34000) / 127);
      c.g[3] = 26000 + acc * 50;
      c.g[4] = 8000;
      break;
    case DVT_CLAP:
      c.f[0].setK(dvCut(p16), 4096);
      c.hp = dvPole(1680 + p16 - def.p16);
      c.k[0] = dvK(5000);
      c.kb[0] = dvKb(tau);
      c.hold = 265 + Math.floor((x * 353) / 127);
      c.click = x > 89 ? 4 : 3;
      c.g[0] = dvLin(tn, 0, 9000);
      c.g[1] = 11000;
      c.g[2] = 30000 + acc * 20;
      break;
    case DVT_HATC:
    case DVT_HATO: {
      const dp = p16 - def.p16;
      const cl = t === DVT_HATC;
      c.f[0].setK(dvCut(1874 + dp), 5120);
      const tp = Math.trunc((tn * 384) / 127) - 192 + dp;
      [c.g[2], c.g[3]] = dvHp1((cl ? 2020 : 1934) + tp);
      [c.g[4], c.g[5]] = dvHp1(2042 + tp);
      c.g[1] = Math.trunc(((cl ? 7209 : 1147) * x) / 64);
      c.kb[0] = dvKb(tau);
      c.k[1] = dvK(300);
      c.kb[1] = dvKb(1500);
      c.out += (c.out * acc * 34) >> 14;
      break;
    }
    case DVT_TOM:
    case DVT_CONGA:
      c.kb[0] = dvKb(tau);
      c.span[0] = P16(p16 + Math.trunc((x * 96) / 127)) - c.inc[0];
      c.k[0] = dvK(10000);
      if (t === DVT_TOM) {
        c.hp = dvPole(1302 + Math.trunc((tn * 384) / 127) - 192);
        c.g[0] = dvLin(tn, 1600, 6000);
      } else {
        c.hp = dvPole(1523);
        c.g[2] = dvLin(tn, 0, 6000);
      }
      c.g[1] = t === DVT_CONGA ? 6144 : 0;
      break;
    case DVT_RIM:
    case DVT_CLAVE:
      c.k[0] = dvK(tau);
      c.inc[1] = P16(p16 + 326);
      c.g[0] = t === DVT_RIM ? dvLin(tn, 24000, 10000) : dvLin(tn, 30000, 24000);
      c.g[1] = t === DVT_RIM ? dvLin(tn, 8000, 24000) : dvLin(tn, 0, 9000);
      c.g[2] = 8192 + Math.trunc((x * (t === DVT_RIM ? 24576 : 32768)) / 127);
      c.g[2] += (c.g[2] * acc) >> 9;
      c.g[3] = Math.trunc((32767 * 4096) / c.g[2]) + 9000;
      break;
    case DVT_BELL:
      c.inc[1] = P16(p16 + 109);
      c.f[0].setK(dvCut(p16 + 130 + Math.trunc((tn * 192) / 127) - 96), 3413);
      c.k[0] = dvK(4000);
      c.kb[0] = dvKb(tau);
      c.g[0] = dvLin(x, 8000, 40000) + acc * 40;
      c.g[1] = dvLin(tn, 0, 5000);
      break;
    case DVT_CYM:
      c.f[0].setK(dvCut(1870 + p16 - def.p16), 5120);
      c.f[1].setK(dvCut(1678 + p16 - def.p16), 5851);
      c.kb[0] = dvKb(tau);
      c.kb[1] = dvKb(150000);
      c.g[0] = dvLin(tn, 6000, 26000);
      c.g[1] = 32767 - c.g[0];
      c.g[2] = dvLin(x, 8000, 32000) + acc * 60;
      break;
  }
}

const dvAt = (v: number, x: number): number => Math.trunc(Math.imul(v, x) / 64);
function dvDrive(d: number): [number, number] {
  const g = d < 4096 ? 4096 : d;
  return [g, Math.floor((19661 * 32768) / softclip((19661 * g) >> 12))];
}

function setupKit(c: DvCoef, p: DvParam): void {
  const kit = DV_KITOF(p.type) - 1;
  const d = p.decay, tn = p.tone, x = p.extra;
  const K = DV_KIT[kit][p.type & 7];
  const v = K.v;
  const acc = p.accent;
  const p16 = clamp(K.p16 + p.tune, K.p16 - 192, K.p16 + 192);
  const dp = p16 - K.p16;
  const tau = dvTauOf(K.tau0, K.oct16, d);
  c.clear();
  c.type = K.run;
  c.inc[0] = P16(p16);
  c.metal = p16;
  c.out = Math.floor((K.gain * p.level) / 127);
  c.out += (c.out * acc * DV_KIT_ACC[kit]) >> 14;
  switch (K.run) {
    case DVT_PUNCH: {
      const b = dvAt(v[0], tn) + (tn > 64 ? tn - 64 : 0);
      c.span[1] = P16(p16 + b) - c.inc[0];
      c.span[0] = P16(p16 + v[2] + b) - P16(p16 + b);
      c.k[0] = dvK(1500);
      c.k[1] = dvK(v[1] * 100);
      c.k[2] = v[8] ? dvK(v[8] * 100) : 0;
      c.kb[0] = dvKb(tau);
      c.hold = v[9];
      c.g[0] = v[3];
      c.g[1] = v[4];
      if (v[5]) {
        c.inc[1] = P16(v[5] + dp);
        c.inc[2] = c.inc[1] >>> 1;
        c.click = Math.floor(0xffffffff / c.inc[2]) & 0xffff;
        c.g[2] = v[6] + ((v[6] * acc) >> 8);
      }
      [c.g[3], c.g[4]] = dvDrive(Math.trunc((v[7] * (x + 64)) / 128));
      break;
    }
    case DVT_SNARE:
      c.click = v[0];
      c.span[0] = P16(p16 + v[1]) - c.inc[0];
      c.k[0] = dvK(v[2] * 100);
      c.k[1] = dvK(Math.floor((tau * v[3]) / 64));
      c.k[2] = dvK(v[8] * 100);
      c.kb[0] = dvKb(tau);
      c.f[0].setK(dvCut(v[6] + (tn - 64) * 2 + dp), v[7]);
      c.hp = dvPole(v[12] + dp);
      c.g[0] = v[4];
      c.g[1] = v[5];
      c.g[2] = dvAt(v[10], x);
      c.g[3] = v[9] + ((v[9] * acc) >> 8);
      c.g[4] = v[11];
      break;
    case DVT_CLAP:
      c.f[0].setK(dvCut(p16 + (tn - 64) * 2), v[1]);
      c.hp = dvPole(v[2] + dp);
      c.k[0] = dvK(v[6] * 100);
      c.kb[0] = dvKb(tau);
      c.hold = Math.trunc((v[7] * (x + 64)) / 128);
      c.click = v[8];
      c.g[0] = dvAt(v[3], tn);
      c.g[1] = v[4];
      c.g[2] = v[5] + acc * 20;
      break;
    case DVT_HATC:
    case DVT_HATO: {
      const tp = (tn - 64) * 3 + dp;
      c.f[0].setK(dvCut(v[0] + dp + (tn - 64) * 2), v[1]);
      [c.g[2], c.g[3]] = dvHp1(v[2] + tp);
      [c.g[4], c.g[5]] = dvHp1(v[3] + tp);
      c.g[1] = dvAt(v[4], x) + (x > 64 ? (x - 64) * 64 : 0);
      c.kb[0] = dvKb(tau);
      c.k[1] = dvK(v[7] * 100);
      c.kb[1] = dvKb(1500);
      c.span[0] = v[5];
      c.span[1] = v[6];
      c.mrow = v[8];
      break;
    }
    case DVT_CYM:
      c.f[0].setK(dvCut(v[0] + dp), v[1]);
      c.f[1].setK(dvCut(v[2] + dp), v[3]);
      c.kb[0] = dvKb(tau);
      c.kb[1] = dvKb(v[6] * 1000);
      c.g[0] = clamp(dvAt(v[4], tn), 0, 32767);
      c.g[1] = 32767 - c.g[0];
      c.g[2] = dvAt(v[5], x) + acc * 60;
      c.span[0] = v[7];
      c.span[1] = v[8];
      c.mrow = v[9];
      break;
    case DVT_TOM:
    case DVT_CONGA:
      c.kb[0] = dvKb(tau);
      c.span[0] = P16(p16 + dvAt(v[0], x) + (x > 64 ? x - 64 : 0)) - c.inc[0];
      c.k[0] = dvK(v[1] * 100);
      c.hp = dvPole(v[2] + (tn - 64) * 3);
      c.g[0] = dvAt(v[3], tn);
      c.g[2] = dvAt(v[4], tn);
      c.g[1] = tn > 64 ? (v[5] > 4096 ? v[5] : 4096) + (tn - 64) * 64 : v[5];
      break;
    case DVT_RIM:
    case DVT_CLAVE:
      c.k[0] = dvK(tau);
      c.inc[1] = P16(p16 + v[0]);
      c.g[0] = v[1];
      c.g[1] = dvAt(v[2], tn);
      [c.g[2], c.g[3]] = dvDrive(Math.trunc((Math.trunc((v[3] * (x + 64)) / 128) * (512 + acc)) / 512));
      break;
    default: // DVT_BELL
      c.inc[1] = P16(p16 + v[0]);
      c.f[0].setK(dvCut(p16 + v[1] + (tn - 64) * 2), v[2]);
      c.k[0] = dvK(v[4] * 100);
      c.kb[0] = dvKb(tau);
      c.g[0] = dvAt(v[3], x) * 2 + acc * 40;
      c.g[1] = dvAt(v[5], tn);
      break;
  }
}

export function dvSetup(c: DvCoef, p: DvParam): void {
  if (DV_KITOF(p.type) - 1 >= 0 && DV_KITOF(p.type) - 1 < DV_NKIT) setupKit(c, p);
  else setupOwn(c, p);
}

export function dvMetalTune(b: DvMetal, c: DvCoef): void {
  const inc = P16(c.metal);
  const r = DV_METAL_R[c.mrow];
  for (let i = 0; i < 6; i++) b.inc[i] = Math.imul(inc >>> 12, r[i]) >>> 0;
}

export function dvMetalRun(b: DvMetal, y: Int32Array, n: number): void {
  let p0 = b.ph[0], p1 = b.ph[1], p2 = b.ph[2], p3 = b.ph[3], p4 = b.ph[4], p5 = b.ph[5];
  for (let i = 0; i < n; i++) {
    p0 = (p0 + b.inc[0]) >>> 0; p1 = (p1 + b.inc[1]) >>> 0; p2 = (p2 + b.inc[2]) >>> 0;
    p3 = (p3 + b.inc[3]) >>> 0; p4 = (p4 + b.inc[4]) >>> 0; p5 = (p5 + b.inc[5]) >>> 0;
    const s = (p0 >>> 31) + (p1 >>> 31) + (p2 >>> 31) + (p3 >>> 31) + (p4 >>> 31) + (p5 >>> 31);
    y[i] = s * 10922 - 32766;
  }
  b.ph[0] = p0; b.ph[1] = p1; b.ph[2] = p2; b.ph[3] = p3; b.ph[4] = p4; b.ph[5] = p5;
}

/** SVF band-pass (the band output), state at s[o], s[o+1]. */
function bp(c: Tsvf, input: number, s: Int32Array, o = 0): number {
  const v3 = input - s[o + 1];
  const v1 = (Math.imul(c.a1, s[o]) + Math.imul(c.a2, v3)) >> 13;
  const v2 = s[o + 1] + ((Math.imul(c.a2, s[o]) + Math.imul(c.a3, v3)) >> 13);
  s[o] = 2 * v1 - s[o];
  s[o + 1] = 2 * v2 - s[o + 1];
  return v1;
}

/** A slow envelope's block: returns [ramp start (Q20), step per sample]. */
function slow(q: Int32Array, qi: number, kb: number): [number, number] {
  const a = q[qi] >> 10;
  q[qi] = mulq16(q[qi], kb);
  return [a, ((q[qi] >> 10) - a) >> 5];
}

const noise = (v: DvVoice): number => {
  v.rng = noiseStep(v.rng);
  return v.rng >> 16;
};

function kickRun(c: DvCoef, v: DvVoice, y: Int32Array, n: number): void {
  let ph = v.ph[0], cph = v.ph[1], wph = v.ph[2], p1 = v.e[0], p2 = v.e[1], cn = v.n, r = v.e[2];
  const k2 = v.cnt ? 32768 : c.k[1];
  const s1 = c.span[0] >>> 16, s2 = c.span[1] >>> 16;
  let [a, d] = slow(v.q, 0, v.cnt ? 65536 : c.kb[0]);
  if (v.cnt) v.cnt--;
  for (let i = 0; i < n; i++) {
    ph = (ph + c.inc[0] + Math.imul(s1, p1) + Math.imul(s2, p2)) >>> 0;
    p1 = u15(p1, c.k[0]);
    p2 = u15(p2, k2);
    const b = sineI(ph) + (Math.imul(sineI((ph << 1) >>> 0), c.g[0]) >> 15) + (Math.imul(sineI(Math.imul(ph, 3) >>> 0), c.g[1]) >> 15);
    a += d;
    let x = Math.imul(b, (a >> 5) - (r >>> 1)) >> 15;
    r = u15(r, c.k[2]);
    if (cn) {
      const w = (32768 - sineI((wph + 0x40000000) >>> 0)) >> 1;
      x += Math.imul(Math.imul(sineI(cph), w) >> 15, c.g[2]) >> 15;
      cph = (cph + c.inc[1]) >>> 0;
      wph = (wph + c.inc[2]) >>> 0;
      cn--;
    }
    y[i] = Math.imul(softclip(Math.imul(x, c.g[3]) >> 12), c.g[4]) >> 15;
  }
  v.ph[0] = ph; v.ph[1] = cph; v.ph[2] = wph; v.e[0] = p1; v.e[1] = p2; v.e[2] = r; v.n = cn;
  v.live = v.q[0] > QUIET ? 1 : 0;
}

function snareRun(c: DvCoef, v: DvVoice, y: Int32Array, n: number): void {
  let p0 = v.ph[0], p1 = v.ph[1], eg = v.e[0], es = v.e[1], ek = v.e[2];
  const gs = c.span[0] >>> 16;
  let lp = v.s[2];
  let [a, d] = slow(v.q, 0, c.kb[0]);
  for (let i = 0; i < n; i++) {
    const inc = (c.inc[0] + Math.imul(gs, eg)) >>> 0;
    const nz = noise(v);
    eg = u15(eg, c.k[0]);
    p0 = (p0 + inc) >>> 0;
    p1 = (p1 + inc + Math.imul(inc >>> 8, c.click)) >>> 0;
    let sh = sineI(p0) + (Math.imul(sineI(p1), c.g[0]) >> 15);
    sh = Math.imul(sh, es >>> 1) >> 15;
    es = u15(es, c.k[1]);
    const bpv = bp(c.f[0], nz, v.s);
    lp += Math.imul(nz - lp, c.hp) >> 15;
    const hp = nz - lp;
    a += d;
    let x = Math.imul(bpv, (((Math.imul(ek >>> 1, c.g[3]) >> 15) + (a >> 5)) >> 1)) >> 14;
    x += Math.imul(hp, Math.imul(ek >>> 1, c.g[4]) >> 15) >> 15;
    ek = u15(ek, c.k[2]);
    x = (Math.imul(sh, c.g[1]) >> 15) + (Math.imul(x, c.g[2]) >> 15);
    y[i] = softclip(Math.imul(x, 5325) >> 12);
  }
  v.ph[0] = p0; v.ph[1] = p1; v.e[0] = eg; v.e[1] = es; v.e[2] = ek; v.s[2] = lp;
  v.live = v.q[0] > QUIET || es > 4 ? 1 : 0;
}

function clapRun(c: DvCoef, v: DvVoice, y: Int32Array, n: number): void {
  let et = v.e[0], cnt = v.n;
  let lp = v.s[2];
  if (v.cnt === 0 && v.q[1] === 0) {
    v.q[0] = 1 << 30;
    v.q[1] = 1;
  }
  let [a, d] = slow(v.q, 0, c.kb[0]);
  for (let i = 0; i < n; i++) {
    const nz = noise(v);
    if (v.cnt && !--cnt) {
      et = 65536;
      cnt = c.hold;
      v.cnt--;
    }
    let x = bp(c.f[0], nz, v.s);
    lp += Math.imul(nz - lp, c.hp) >> 15;
    x += Math.imul(nz - lp, c.g[0]) >> 15;
    a += d;
    const env = (Math.imul(et >>> 1, c.g[2]) >> 15) + (Math.imul(a >> 5, c.g[1]) >> 15);
    et = u15(et, c.k[0]);
    y[i] = Math.imul(x, env >> 1) >> 14;
  }
  v.e[0] = et; v.n = cnt; v.s[2] = lp;
  v.live = v.cnt || v.q[0] > QUIET || et > 4 ? 1 : 0;
}

function hatRun(c: DvCoef, v: DvVoice, m: Int32Array, y: Int32Array, n: number): void {
  let r = v.e[1];
  let y1 = v.s[2], x1 = v.s[3], z1 = v.s[4], m1 = v.ph[0] | 0;
  let [a, d] = slow(v.q, 0, v.choke ? c.kb[1] : c.kb[0]);
  for (let i = 0; i < n; i++) {
    const b = bp(c.f[0], m[i], v.s);
    y1 = (Math.imul(c.g[2], b - x1) + Math.imul(c.g[3], y1)) >> 14;
    z1 = (Math.imul(c.g[4], m[i] - m1) + Math.imul(c.g[5], z1)) >> 14;
    x1 = b;
    m1 = m[i];
    const x = y1 + (Math.imul(z1, c.g[1]) >> 12);
    a += d;
    y[i] = Math.imul(x, ((a >> 5) - (r >>> 1)) >> 2) >> 13;
    r = u15(r, c.k[1]);
  }
  v.e[1] = r; v.s[2] = y1; v.s[3] = x1; v.s[4] = z1; v.ph[0] = m1 >>> 0;
  v.live = v.q[0] > QUIET ? 1 : 0;
}

function tomRun(c: DvCoef, v: DvVoice, y: Int32Array, n: number): void {
  let ph = v.ph[0], es = v.e[0];
  const bs = c.span[0] >>> 16;
  let lp = v.s[2];
  let [a, d] = slow(v.q, 0, c.kb[0]);
  for (let i = 0; i < n; i++) {
    a += d;
    const al = a >> 5;
    ph = (ph + c.inc[0] + Math.imul(bs, (Math.imul(al, al) >> 14) >>> 0)) >>> 0;
    let x = Math.imul(sineI(ph), al) >> 15;
    const nz = noise(v);
    lp += Math.imul(nz - lp, c.hp) >> 15;
    x += Math.imul((Math.imul(lp, c.g[0]) >> 15) + (Math.imul(nz - lp, c.g[2]) >> 15), es >>> 1) >> 15;
    es = u15(es, c.k[0]);
    if (c.g[1]) x = softclip(Math.imul(x, c.g[1]) >> 12);
    y[i] = x;
  }
  v.ph[0] = ph; v.e[0] = es; v.s[2] = lp;
  v.live = v.q[0] > QUIET ? 1 : 0;
}

function rimRun(c: DvCoef, v: DvVoice, y: Int32Array, n: number): void {
  let p0 = v.ph[0], p1 = v.ph[1], e = v.e[0];
  for (let i = 0; i < n; i++) {
    p0 = (p0 + c.inc[0]) >>> 0;
    p1 = (p1 + c.inc[1]) >>> 0;
    let x = (Math.imul(sineI(p0), c.g[0]) >> 15) + (Math.imul(sineI(p1), c.g[1]) >> 15);
    x = Math.imul(x, e >>> 1) >> 15;
    e = u15(e, c.k[0]);
    y[i] = Math.imul(softclip(Math.imul(x, c.g[2]) >> 12), c.g[3]) >> 15;
  }
  v.ph[0] = p0; v.ph[1] = p1; v.e[0] = e;
  v.live = e > 4 ? 1 : 0;
}

function bellRun(c: DvCoef, v: DvVoice, y: Int32Array, n: number): void {
  let p0 = v.ph[0], p1 = v.ph[1], e = v.e[0];
  let [a, d] = slow(v.q, 0, c.kb[0]);
  for (let i = 0; i < n; i++) {
    p0 = (p0 + c.inc[0]) >>> 0;
    p1 = (p1 + c.inc[1]) >>> 0;
    let x = ((p0 >>> 31) + (p1 >>> 31)) * 16384 - 16384;
    x = bp(c.f[0], x, v.s) + (Math.imul(x, c.g[1]) >> 15);
    a += d;
    y[i] = Math.imul(x, ((a >> 5) + (Math.imul(e >>> 1, c.g[0]) >> 15)) >> 2) >> 13;
    e = u15(e, c.k[0]);
  }
  v.ph[0] = p0; v.ph[1] = p1; v.e[0] = e;
  v.live = v.q[0] > QUIET ? 1 : 0;
}

function cymRun(c: DvCoef, v: DvVoice, m: Int32Array, y: Int32Array, n: number): void {
  let [a, d] = slow(v.q, 0, c.kb[0]);
  let [b, e] = slow(v.q, 1, c.kb[1]);
  for (let i = 0; i < n; i++) {
    const hi = bp(c.f[0], m[i], v.s);
    const lo = bp(c.f[1], m[i], v.s, 2);
    a += d;
    b += e;
    const r = a >> 5;
    const s = Math.imul(b >> 5, c.g[2]) >> 15;
    y[i] = (Math.imul(Math.imul(hi, (r + s) >> 1) >> 15, c.g[0]) >> 15) + (Math.imul(Math.imul(lo, s) >> 15, c.g[1]) >> 15);
  }
  v.live = v.q[0] > QUIET ? 1 : 0;
}

function metalMix(c: DvCoef, v: DvVoice, m: Int32Array, y: Int32Array, n: number): void {
  const gm = c.span[0] | 0, gn = c.span[1] | 0;
  for (let i = 0; i < n; i++) {
    const nz = noise(v);
    y[i] = (Math.imul(m[i], gm) + Math.imul(nz, gn)) >> 15;
  }
}

export function dvInit(v: DvVoice, type: number): void {
  v.type = type; v.trig = 0; v.choke = 0; v.live = 0; v.n = 0; v.cnt = 0;
  v.ph.fill(0); v.e.fill(0); v.q.fill(0); v.s.fill(0); v.rng = 0;
}
export const dvTrigger = (v: DvVoice): void => { v.trig = 1; };
export const dvChoke = (v: DvVoice): void => { v.choke = 1; };
export const dvUsesMetal = (type: number): boolean => type === DVT_HATC || type === DVT_HATO || type === DVT_CYM;

function strike(c: DvCoef, v: DvVoice): void {
  dvInit(v, c.type);
  v.live = 1;
  v.rng = (DV_SEED + c.type) | 0;
  v.e[0] = v.e[1] = v.e[2] = 65536;
  v.q[0] = 1 << 30;
  switch (c.type) {
    case DVT_PUNCH:
    case DVT_ROUND:
      v.cnt = c.hold;
      v.n = c.click;
      v.e[2] = c.k[2] ? 65536 : 0;
      break;
    case DVT_CLAP:
      v.q[0] = 0;
      v.cnt = (c.click - 1) & 0xffff;
      v.n = c.hold;
      break;
    case DVT_CYM:
      v.q[1] = 1 << 30;
      break;
  }
}

function out(c: DvCoef, y: Int32Array, n: number): void {
  for (let i = 0; i < n; i++) {
    let s = Math.imul(y[i], c.out) >> 12;
    let a = s < 0 ? -s : s;
    if (a > 16384) {
      a = 16384 + (softclip((a - 16384) * 2) >> 1);
      s = s < 0 ? -a : a;
    }
    y[i] = s;
  }
}

/** One block of the voice into y (Q15 at its level); metal: the metal source's block, or null. */
export function dvRun(c: DvCoef, v: DvVoice, metal: Int32Array | null, y: Int32Array, n: number): void {
  if (v.trig) {
    strike(c, v);
  }
  if (!v.live || v.type !== c.type || (dvUsesMetal(c.type) && !metal)) {
    y.fill(0, 0, n);
    v.live = 0;
    return;
  }
  let m = metal;
  if (dvUsesMetal(c.type) && c.span[1]) {
    metalMix(c, v, metal!, y, n);
    m = y;
  }
  switch (c.type) {
    case DVT_PUNCH: case DVT_ROUND: kickRun(c, v, y, n); break;
    case DVT_SNARE: snareRun(c, v, y, n); break;
    case DVT_CLAP: clapRun(c, v, y, n); break;
    case DVT_HATC: case DVT_HATO: hatRun(c, v, m!, y, n); break;
    case DVT_TOM: case DVT_CONGA: tomRun(c, v, y, n); break;
    case DVT_RIM: case DVT_CLAVE: rimRun(c, v, y, n); break;
    case DVT_BELL: bellRun(c, v, y, n); break;
    default: cymRun(c, v, m!, y, n); break;
  }
  out(c, y, n);
}

/** The run a type plays through (DVT_*). */
export function dvRunType(type: number): number {
  const k = DV_KITOF(type) - 1;
  return k >= 0 && k < DV_NKIT ? DV_KIT[k][type & 7].run : type < DVT_COUNT ? type : 0;
}

/** The designed parameters of a type (LEVEL 100, no accent); a model kit's lane: 64 each. */
export function dvDefault(type: number): DvParam {
  const own = DV_KITOF(type) === 0;
  return {
    type,
    decay: own ? DV_DEF[type].def[0] : 64,
    tone: own ? DV_DEF[type].def[1] : 64,
    extra: own ? DV_DEF[type].def[2] : 64,
    level: 100,
    accent: 0,
    tune: 0,
  };
}

void CTL;
