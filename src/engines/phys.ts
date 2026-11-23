// Port of Felucca's eng_phys.c, phys_dsp.c and phys_symp.c: the PHYS engine, physical models (a modal bank, an
// extended Karplus-Strong string, a membrane, a string with sympathetic strings). The DSP is DaisySP (Electrosmith,
// Emilie Gillet; MIT) and Rings (Emilie Gillet; MIT) ported to fixed point by Felucca (GPL-3.0-only). See NOTICE.
// 64-bit C arithmetic: exact double helpers in the sample loops, BigInt in the per-block setup.
import { clamp, pitchInc, softclip, voiceAmp } from "./dsp";
import { mulsh } from "./i64";
import { CTL, EngineDef, EngVoice, F, P_E0, P_E1, P_E2, P_E3, P_E4, P_E5, P_E6, P_E7, P_ROOT, ParamDesc, Track, Vmod } from "./types";

const NMODE = 12, LINE = 512, LMASK = LINE - 1, SLINE = 128, SMASK = SLINE - 1, ONE = 1 << 20;
const YLINE = 256, YMASK = YLINE - 1, NSYMP = 3, NMEMB = 10;
const B = BigInt;
const u32 = (x: bigint): number => Number(BigInt.asUintN(32, x));
const i32 = (x: bigint): number => Number(BigInt.asIntN(32, x));

/** (int32)(((int64)a * b) >> sh), exact. */
function m(a: number, b: number, sh: number): number {
  const p = a * b;
  if (p > -4503599627370496 && p < 4503599627370496) return Math.floor(p / 2 ** sh) | 0;
  if (sh >= 16 && a >= -2147483648 && a <= 2147483647 && b >= -2147483648 && b <= 2147483647) return mulsh(a, b, sh) | 0;
  return Number(BigInt.asIntN(32, (B(a) * B(b)) >> B(sh)));
}
/** The 64-bit product shifted, without the int32 cast. */
function m64(a: number, b: number, sh: number): number {
  const p = a * b;
  if (p > -4503599627370496 && p < 4503599627370496) return Math.floor(p / 2 ** sh);
  return mulsh(a, b, sh);
}
/** floor((a*b + add) / 2^30) and the low 30 bits, a, b int32. */
function acc30(a: number, b: number, add: number): [number, number] {
  const hi = a * (b >> 16);
  const lo = a * (b & 0xffff);
  const hq = Math.floor(hi / 16384);
  const t = (hi - hq * 16384) * 65536 + lo + add;
  const tq = Math.floor(t / 1073741824);
  return [hq + tq, t - tq * 1073741824];
}

function rand(s: Uint32Array, i: number): number {
  let x = s[i];
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  s[i] = x;
  return s[i];
}

function pxSin(ph: number): number {
  const q = ph >>> 30;
  let r = ph & 0x3fffffff;
  if (q & 1) r = 0x40000000 - r;
  const t = r;
  const t2 = m(t, t, 30);
  let p = 172272;
  p = 5026995 - m(t2, p, 30);
  p = 85569306 - m(t2, p, 30);
  p = 693598668 - m(t2, p, 30);
  p = 1686629713 - m(t2, p, 30);
  p = m(t, p, 30);
  return q & 2 ? -p : p;
}

/** 2^x, x Q16 (-16 <= x < 15); Q16 (uint32 as a number). */
function pxExp2(x: number): number {
  const i = x >> 16;
  const f = (x & 0xffff) * 16384;
  if (i < -16) return 0;
  if (i > 14) return 0xffffffff;
  let p = 16377;
  p = 165394 + m64(f, p, 30);
  p = 1431680 + m64(f, p, 30);
  p = 10327387 + m64(f, p, 30);
  p = 59597083 + m64(f, p, 30);
  p = 257941248 + m64(f, p, 30);
  p = 744261118 + m64(f, p, 30);
  p = 1073741824 + m64(f, p, 30);
  return i >= -14 ? Math.floor(p / 2 ** (14 - i)) : Math.floor(Math.floor(p / 268435456) / 2 ** (-14 - i));
}

function pxFasttan(f: number): number {
  const x = f >>> 1;
  const x2 = m64(x, x, 31);
  let p = 169584874 + m64(935957068, x2, 31);
  p = 52707179 + m64(x2, p, 31);
  return m64(x, p, 27) | 0;
}

function pxAtan(x: number): number {
  const x2 = m(x, x, 30);
  let p = 12585543;
  p = 56536072 - m(x2, p, 30);
  p = 125018842 - m(x2, p, 30);
  p = 207815708 - m(x2, p, 30);
  p = 357151731 - m(x2, p, 30);
  p = 1073717407 - m(x2, p, 30);
  return m(x, p, 30);
}

const isqrt = (v: number): number => Math.floor(Math.sqrt(v));

class Svf { g = 0; rpg = 0; gh = 0; }

function svfCoef(c: Svf, f: number, q8: number): void {
  const g = pxFasttan(f);
  const r = B.asUintN(32, ((1n << 36n) + B(q8) - 1n) / B(q8));
  const den = (1n << 28n) + ((r * B(g >>> 0)) >> 28n) + ((B(g >>> 0) * B(g >>> 0)) >> 28n);
  const d24 = (den + 15n) >> 4n;
  const h = B.asUintN(32, (1n << 54n) / d24);
  c.g = g;
  c.rpg = i32(r + B(g >>> 0));
  c.gh = i32((h * B(g >>> 0)) >> 28n);
}

interface Csvf { freq: number; damp: number; drive: number }
interface CsvfSt { low: number; band: number }

function csvfCoef(c: Csvf, f: number, res: number, preDrive: number): void {
  const fc = f > 0x55555555 ? 0x55555555 : f;
  const a = fc >>> 1 > 0x40000000 ? 0x40000000 : fc >>> 1;
  const fr = pxSin(a >>> 1) << 1;
  let r4 = 0;
  if (res > 0) {
    r4 = isqrt(res * 65536);
    r4 = isqrt(r4 * 65536);
  }
  const d1 = (65536 - r4) << 13;
  let d2: number;
  if (fr > 0) {
    const inv = Number((1n << 59n) / B(fr >>> 0));
    d2 = inv > 1 << 30 ? 2 << 28 : (inv | 0) - (fr >> 3);
    if (d2 > 2 << 28) d2 = 2 << 28;
  } else {
    d2 = 2 << 28;
  }
  c.freq = fr;
  c.damp = d1 < d2 ? d1 : d2;
  c.drive = Math.floor((preDrive * res) / 4) | 0;
}

function csvfPass(c: Csvf, s: CsvfSt, input: number): void {
  const b = s.band;
  const notch = input - m(c.damp, b, 28);
  s.low = (s.low + m(c.freq, b, 30)) | 0;
  const high = notch - s.low;
  const b3 = m(m(b, b, 20), b, 20);
  s.band = (b + m(c.freq, high, 30) - m(c.drive, b3, 30)) | 0;
}

// ---- modal ----
class Modal {
  s = new Int32Array(NMODE * 2);
  e1 = 0; e2 = 0;
  rng = new Uint32Array(1);
  benv = 0;
  trig = 0;
}
class ModalBlk {
  g = new Int32Array(NMODE); rpg = new Int32Array(NMODE); gh = new Int32Array(NMODE); a = new Int32Array(NMODE);
  n = 0;
  ex = new Svf();
  strike = 0; dustThr = 0; dustInv = 0; dustGain = 0; dustDc = 0;
}

function stiff(s: number): number {
  if (s < 16384) return -((16384 - s) >> 2);
  if (s < 19661) return 0;
  if (s < 58982) return Math.floor(((s - 19661) * 109227) / 65536) | 0;
  s = (s - 58982) * 10;
  s = m(s, s, 16);
  return 98304 - (pxSin(((s << 15) + 0x40000000) >>> 0) >> 15);
}

function modalExciter(Bk: ModalBlk, M: Modal, f0c: number, brightness: number, b: number, d: number, accent: number, bow: number): void {
  const ex = Math.trunc(((m(b, 131072 - b, 16) - 32768) * (bow ? 36 : 60)) / 12);
  const fr = B.asUintN(64, (B(f0c) * (bow ? 4n : 2n) * B(pxExp2(ex))) >> 16n);
  const cut = fr > 2143260078n ? 2143260078 : fr < 65536n ? 65536 : Number(fr);
  svfCoef(Bk.ex, cut, bow ? 179 : 384);
  Bk.strike = 0;
  Bk.dustThr = 0;
  if (bow) {
    let dn = m(brightness, brightness, 16);
    dn = m(dn, dn, 16);
    const df = 3 + m(dn, 65533, 16);
    Bk.dustThr = u32(B(df) * 19661n);
    Bk.dustInv = u32((1n << 47n) / B(Bk.dustThr));
    Bk.dustGain = m(m(m(262144 - 3 * df, accent, 16), bow, 16), pxExp2(-m(d, 217579, 16)) | 0, 16);
    Bk.dustDc = i32((B(Bk.dustThr) * B(Bk.dustGain >>> 0)) >> 29n);
  } else if (M.trig) {
    const amp = m(7864 + m(5243, accent, 16), 65536 - (d >> 1), 16);
    const c2 = u32((B(cut) * B(cut)) >> 32n);
    let v = (B(amp >>> 0) * B(pxExp2(c2 >>> 15 | 0))) << 16n;
    v /= B(cut);
    Bk.strike = v > 0x7fffffffn ? 0x7fffffff : Number(BigInt.asIntN(32, v));
    M.trig = 0;
  }
}

function modalQ(structure: number, b: number, d: number): [bigint, number] {
  const bb = m(m(b, 65536 - m(structure, 19661, 16), 16), 65536 - m(d, 19661, 16), 16);
  const ql = m(m(bb, 131072 - bb, 16), 55706, 16) + 9830;
  return [(500n * B(pxExp2(m64(d, 870537, 16) | 0))) >> 8n, ql];
}

function modalBlock(Bk: ModalBlk, M: Modal, f0in: number, structure: number, brightness: number, damping: number, accent: number, pos: number, bow: number): void {
  const b = brightness + m(accent >> 2, 65536 - brightness, 16);
  const d = damping + m(accent >> 2, 65536 - damping, 16);
  const st = stiff(structure);
  let stretch = 65536;
  modalExciter(Bk, M, f0in > 0x40000000 ? 0x40000000 : f0in, brightness, b, d, accent, bow);
  const comp = (1n << 32n) / B(u32(B(65536 + st + m(st, st < 0 ? 60948 : 64225, 16))));
  const f0 = u32((B(f0in) * B.asUintN(32, comp)) >> 16n);
  let [q8, ql] = modalQ(structure, b, d);
  let st2 = st;
  let harm = B(f0);
  let phs = 0;
  let i = 0;
  for (; i < NMODE; i++) {
    const mf = (harm * B(stretch >>> 0)) >> 16n;
    if (mf >= 2143260078n) break;
    const att = 65536 - Number(mf >> 15n);
    const amp = m(pxSin((phs + 0x40000000) >>> 0), 16384, 16);
    const c = new Svf();
    svfCoef(c, Number(mf), u32(256n + ((mf * q8) >> 32n)));
    Bk.g[i] = c.g; Bk.rpg[i] = c.rpg; Bk.gh[i] = c.gh;
    Bk.a[i] = m(amp, att, 18);
    stretch += st2;
    st2 = m(st2, st2 < 0 ? 60948 : 64225, 16);
    harm += B(f0);
    q8 = (q8 * B(ql >>> 0)) >> 16n;
    phs = (phs + (pos << 16)) >>> 0;
  }
  Bk.n = i;
  for (; i < NMODE; i++) M.s[i * 2] = M.s[i * 2 + 1] = 0;
  for (i = 0; i < Bk.n; i++) {
    M.s[i * 2] = clamp(M.s[i * 2], -(1 << 28), 1 << 28);
    M.s[i * 2 + 1] = clamp(M.s[i * 2 + 1], -(1 << 28), 1 << 28);
  }
}

const MEMB_IDEAL = [65536, 104421, 139955, 150432, 173871, 191188, 206797, 229386, 235830, 239039];
const MEMB_LOADED = [65536, 131072, 196608, 197263, 262144, 261489, 327680, 328991, 326369, 393216];
const MEMB_M = [0, 1, 2, 0, 3, 1, 4, 2, 0, 5];

function membBlock(Bk: ModalBlk, M: Modal, f0: number, harm: number, brightness: number, damping: number, accent: number, pos: number, bend: number): void {
  const b = brightness + m(accent >> 2, 65536 - brightness, 16);
  const d = damping + m(accent >> 2, 65536 - damping, 16);
  const pm = pos + (pos >> 1);
  const w = [0, 0, 0, 0, 0, 0];
  let f = B(f0);
  if (M.trig) M.benv = 65536;
  if (M.benv) {
    f = (f * B(pxExp2(Math.trunc(m(bend, M.benv, 16) / 12)))) >> 16n;
    M.benv = m(M.benv, 64220, 16);
    if (M.benv < 64) M.benv = 0;
  }
  if (f > 0x40000000n) f = 0x40000000n;
  modalExciter(Bk, M, Number(f), brightness, b, d, accent, 0);
  let [q8, ql] = modalQ(0, b, d);
  w[0] = 65536 - m(pos, 39322, 16);
  w[1] = pm > 65536 ? 65536 : pm;
  for (let i = 2; i < 6; i++) w[i] = m(w[i - 1], w[1], 16);
  let i = 0;
  for (; i < NMEMB; i++) {
    const r = (MEMB_IDEAL[i] + m(MEMB_LOADED[i] - MEMB_IDEAL[i], harm, 16)) >>> 0;
    const mf = (f * B(r)) >> 16n;
    if (mf >= 2143260078n) break;
    const c = new Svf();
    svfCoef(c, Number(mf), u32(256n + ((mf * q8) >> 32n)));
    Bk.g[i] = c.g; Bk.rpg[i] = c.rpg; Bk.gh[i] = c.gh;
    const inv = Number((1n << 32n) / B(r)) | 0;
    Bk.a[i] = m(m(w[MEMB_M[i]] << 14, 65536 - Number(mf >> 15n), 18), m(inv, inv, 16), 16);
    q8 = (q8 * B(ql >>> 0)) >> 16n;
  }
  Bk.n = i;
  for (; i < NMODE; i++) M.s[i * 2] = M.s[i * 2 + 1] = 0;
  for (i = 0; i < Bk.n; i++) {
    M.s[i * 2] = clamp(M.s[i * 2], -(1 << 28), 1 << 28);
    M.s[i * 2 + 1] = clamp(M.s[i * 2 + 1], -(1 << 28), 1 << 28);
  }
}

const mx = new Int32Array(32);

function modalRun(Bk: ModalBlk, M: Modal, out: Int32Array, aux: Int32Array, n: number): void {
  const nm = Bk.n;
  if (n > 32) n = 32;
  for (let i = 0; i < n; i++) aux[i] = mx[i] = 0;
  if (Bk.dustThr || Bk.strike || M.e1 || M.e2) {
    let e1 = M.e1, e2 = M.e2, big = 0;
    const ex = Bk.ex;
    for (let i = 0; i < n; i++) {
      let input = 0n;
      if (Bk.dustThr) {
        const u = rand(M.rng, 0);
        if (u < Bk.dustThr) input = (((B(u) * B(Bk.dustInv)) >> 32n) * B(Bk.dustGain >>> 0)) >> 7n;
      } else if (!i && Bk.strike) {
        input = B(Bk.strike) << 8n;
      }
      const tt = Number(BigInt.asIntN(32, (B(ex.gh) * (input - B(m(ex.rpg, e1, 28)) - B(e2))) >> 30n));
      let bp = e1 + tt;
      e1 = bp + tt;
      const t2 = m(ex.g, bp, 28);
      bp = e2 + t2;
      e2 = bp + t2;
      aux[i] = (bp >> 4) - (Bk.dustThr ? Bk.dustDc : 0);
      mx[i] = bp >> 2;
      big |= (bp + 256) >> 9;
    }
    if (!big && !Bk.dustThr && e1 > -256 && e1 < 256 && e2 > -256 && e2 < 256) e1 = e2 = 0;
    M.e1 = clamp(e1, -(1 << 30), 1 << 30);
    M.e2 = clamp(e2, -(1 << 30), 1 << 30);
  }
  for (let i = 0; i < n; i++) {
    let accH = 0, accL = 0;
    const xi = mx[i];
    for (let k = 0; k < nm; k++) {
      const s1 = M.s[k * 2], s2 = M.s[k * 2 + 1];
      let t = m(Bk.gh[k], xi - m(Bk.rpg[k], s1, 28) - s2, 30);
      const v = (s1 + t) | 0;
      M.s[k * 2] = (v + t) | 0;
      t = m(Bk.g[k], v, 28);
      M.s[k * 2 + 1] = (s2 + t + t) | 0;
      accH += Bk.a[k] * (v >> 16);
      accL += Bk.a[k] * (v & 0xffff);
    }
    const hq = Math.floor(accH / 16384);
    out[i] = (hq + Math.floor(((accH - hq * 16384) * 65536 + accL) / 1073741824)) | 0;
  }
}

// ---- string ----
class Str {
  line = new Int32Array(LINE);
  sline = new Int32Array(SLINE);
  wp = 0; swp = 0;
  disp = 0; bridge = 0;
  dcX = 0; dcY = 0; dcE = 0;
  lp = 0; ein = 0;
  src = 0;
  out0 = 0; out1 = 0;
  ex: CsvfSt = { low: 0, band: 0 };
  exc: Csvf = { freq: 0, damp: 0, drive: 0 };
  bk = 0; bn = 0; bd = 0;
  nzA = new Uint32Array(1); nzB = new Uint32Array(1);
  rng = new Uint32Array(1);
  trig = 0;
}
class StrBlk {
  delay = 0; srcRatio = 0; comp = 0; G = 0; mAp = 0; mMain = 0; apGain = 0;
  noiseAmt = 0; noiseFlt = 0; curving = 0; curved = false;
  dustThr = 0; dustInv = 0; dustGain = 0; dustDc = 0;
}

const period = (f: number): number => Number((1n << 48n) / B(f));

function stringBlock(Bk: StrBlk, S: Str, f0: number, structure: number, brightness: number, damping: number, accent: number, bow: number, pos: number): void {
  let b = brightness + m(accent >> 2, 65536 - brightness, 16);
  const d = damping + m(accent >> 2, 65536 - damping, 16);
  let f = f0 > 0x40000000 ? 0x40000000 : f0;
  if (f < 65536) f = 65536;
  let nl = structure < 15729 ? m64(structure - 15729, 273024, 16) : structure > 17039 ? m64(structure - 17039, 88562, 16) : 0;
  nl = clamp(nl | 0, -65536, 65536);
  if (S.trig || bow) {
    const oct = (m(b, 131072 - b, 16) - 32768) * 6;
    const c = (B(f) * 4n * B(pxExp2(oct))) >> 16n;
    csvfCoef(S.exc, c > 2143260078n ? 2143260078 : Number(c), bow ? 65536 : 32768, 32768);
    if (S.trig) {
      const per = period(f);
      S.bk = 0;
      S.bn = per >>> 16;
      S.bd = u32((B(per) * B(pos >>> 0)) >> 33n);
      S.nzA[0] = S.nzB[0] = (rand(S.rng, 0) | 1) >>> 0;
      S.trig = 0;
    }
  }
  Bk.dustThr = 0;
  if (bow) {
    let dn = m(brightness, brightness, 16);
    dn = m(dn, dn, 16);
    const dfx = 3 + m(dn, 65533, 16);
    Bk.dustThr = u32(B(dfx) * 19661n);
    Bk.dustInv = u32((1n << 47n) / B(Bk.dustThr));
    Bk.dustGain = m(m(m(524288 - 6 * dfx, accent, 16), bow, 16), pxExp2(-m(d, 217579, 16)) | 0, 16);
    Bk.dustDc = i32((B(Bk.dustThr) * B(Bk.dustGain >>> 0)) >> 29n);
  }
  Bk.curved = nl < 0;
  if (nl < 0) nl = -nl;
  let delay = period(f);
  if (delay > (LINE - 4) * 65536) delay = (LINE - 4) * 65536;
  if (delay < 4 * 65536) delay = 4 * 65536;
  const ratio = u32((B(delay) * B(f)) >> 18n);
  Bk.srcRatio = ratio >= 1073634406 ? 1 << 30 : ratio | 0;
  if (Bk.srcRatio === 1 << 30) S.src = 1 << 30;
  Bk.delay = delay;
  let dcut = 786432 + m(m(d, d, 16), 3932160, 16) + b * 24;
  if (dcut > 84 * 65536) dcut = 84 * 65536;
  let df: number;
  {
    const x64 = (B(f) * B(pxExp2(Math.trunc(dcut / 12)))) >> 16n;
    df = x64 > 2143260078n ? 2143260078 : Number(x64);
  }
  if (d >= 62259) {
    const ti = (d - 62259) * 20;
    b += m(ti, 65536 - b, 16);
    df = (df + u32(((B(2147054347 - df)) * B(ti >>> 0)) >> 16n)) >>> 0;
    dcut += m(ti, (128 << 16) - dcut, 16);
  }
  if (Bk.srcRatio < 1 << 30) {
    const x64 = (B(df) << 30n) / B(Bk.srcRatio >>> 0);
    df = x64 > 2134624419n ? 2134624419 : Number(x64);
  }
  if (df > 2134624419) df = 2134624419;
  {
    const s = pxSin(df >>> 1);
    const c = pxSin(((df >>> 1) + 0x40000000) >>> 0);
    Bk.G = Number(BigInt.asIntN(32, (B(s) << 30n) / B(s + c)));
  }
  const x = Number(BigInt.asIntN(32, (1n << 46n) / B(pxExp2(Math.trunc(dcut / 12)))));
  Bk.comp = (1 << 30) - m(pxAtan(x), 341782638, 30);
  const sp = m(m(nl, 131072 - nl, 16), 14746, 16);
  let sc = u32((B(delay) * 238n) >> 16n) | 0;
  sc = clamp(sc, 65536, 137626);
  Bk.mAp = sp << 14;
  Bk.mMain = (1 << 30) - m(sp, m(26739 - m(sp, 20185, 16), sc, 16), 2);
  const na = nl > 49152 ? (nl - 49152) * 4 : 0;
  Bk.noiseAmt = m(m(na, na, 16), 107374182, 16);
  Bk.noiseFlt = 64424509 + m(m(b, b, 16), 1009317315, 16);
  Bk.curving = m(m(nl, nl, 16), 10737418, 16);
  Bk.apGain = -Number(BigInt.asIntN(32, (663568203n * B(nl)) / B(9830 + nl)));
}

function hermite(l: Int32Array, wp: number, delay: number): number {
  const t = wp + (delay >>> 16);
  const xm1 = l[(t - 1) & LMASK], x0 = l[t & LMASK], x1 = l[(t + 1) & LMASK], x2 = l[(t + 2) & LMASK];
  const f = delay & 0xffff;
  const c = (x1 - xm1) >> 1, v = x0 - x1, w = c + v, a = w + v + ((x2 - x0) >> 1), bn = w + a;
  let y = Math.floor((a * f) / 65536) - bn;
  y = Math.floor((y * f) / 65536) + c;
  return (Math.floor((y * f) / 65536) + x0) | 0;
}

function stringExcite(Bk: StrBlk, S: Str, aux: Int32Array, n: number): void {
  let bk = S.bk;
  const bend = S.bn + S.bd;
  const ex = S.ex;
  for (let i = 0; i < n; i++) {
    let input = 0, x = 0;
    if (Bk.dustThr) {
      const u = rand(S.rng, 0);
      if (u < Bk.dustThr) x = Number(BigInt.asIntN(32, (((B(u) * B(Bk.dustInv)) >> 32n) * B(Bk.dustGain >>> 0)) >> 11n));
    } else if (bk < bend) {
      if (bk < S.bn) x = (rand(S.nzA, 0) >>> (S.bd ? 12 : 11)) - (S.bd ? 1 << 19 : 1 << 20);
      if (S.bd && bk >= S.bd) x -= (rand(S.nzB, 0) >>> 12) - (1 << 19);
      bk++;
    }
    if (x || ex.low || ex.band) {
      csvfPass(S.exc, ex, x);
      const l0 = ex.low;
      csvfPass(S.exc, ex, x);
      input = (l0 + ex.low) >> 1;
      ex.band = clamp(ex.band, -(5 << 20), 5 << 20);
      ex.low = clamp(ex.low, -(16 << 20), 16 << 20);
      if (!x && ex.low > -16 && ex.low < 16 && ex.band > -16 && ex.band < 16) ex.low = ex.band = 0;
    }
    aux[i] = input - (Bk.dustThr ? Bk.dustDc : 0);
  }
  S.bk = bk;
}

function stringRun(Bk: StrBlk, S: Str, input: Int32Array, out: Int32Array, n: number): void {
  let wp = S.wp, swp = S.swp;
  let src = S.src;
  let o0 = S.out0, o1 = S.out1, lp = S.lp, disp = S.disp, bridge = S.bridge;
  let dcx = S.dcX, dcy = S.dcY, dce = S.dcE, ein = S.ein;
  for (let i = 0; i < n; i++) {
    ein = (ein + input[i]) | 0;
    src = (src + (Bk.srcRatio >>> 0)) >>> 0;
    if (src > 1 << 30) {
      let dl = Math.floor(m64(Bk.delay, Bk.comp, 30));
      let s: number;
      src -= 1 << 30;
      if (!Bk.curved) {
        const nz = (rand(S.rng, 0) >>> 12) - (1 << 19);
        disp = (disp + m(Bk.noiseFlt, nz - disp, 30)) | 0;
        dl = Math.floor(m64(dl, (1 << 30) + m(disp, Bk.noiseAmt, 20), 30));
        const ap = Math.floor(m64(dl, Bk.mAp, 30));
        const mn = Math.floor(m64(dl, Bk.mMain, 30));
        if (ap >= 4 * 65536 && mn >= 4 * 65536) {
          const t = wp + (mn >>> 16);
          const a = S.line[t & LMASK], bb = S.line[(t + 1) & LMASK];
          s = a + m(bb - a, mn & 0xffff, 16);
          const rd = S.sline[(swp + (ap >>> 16)) & SMASK];
          const w = s + m(Bk.apGain, rd, 30);
          S.sline[swp] = w;
          swp = (swp - 1) & SMASK;
          s = rd - m(w, Bk.apGain, 30);
        } else {
          s = hermite(S.line, wp, dl);
        }
      } else {
        dl = Math.floor(m64(dl, (1 << 30) - m(bridge, Bk.curving, 20), 30));
        s = hermite(S.line, wp, dl);
        const as = s < 0 ? -s : s;
        const val = as - 26214;
        bridge = val > 0 ? (s > 0 ? 2 * val : -3 * val) : 0;
      }
      s = clamp(s + ein, -20 * ONE, 20 * ONE);
      ein = 0;
      {
        const [q, r] = acc30(1073498345, dcy, dce);
        const y = (s - dcx + q) | 0;
        dce = r;
        dcx = s;
        dcy = y;
        s = y;
      }
      {
        const v = m(Bk.G, s - lp, 30);
        s = (lp + v) | 0;
        lp = (s + v) | 0;
      }
      S.line[wp] = s;
      wp = (wp - 1) & LMASK;
      o1 = o0;
      o0 = s;
    }
    out[i] = (o1 + m(o0 - o1, src | 0, 30)) | 0;
  }
  S.wp = wp; S.swp = swp; S.src = src;
  S.out0 = o0; S.out1 = o1; S.lp = lp; S.disp = disp; S.bridge = bridge;
  S.dcX = dcx; S.dcY = dcy; S.dcE = dce;
  S.ein = clamp(ein, -20 * ONE, 20 * ONE);
}

// ---- sympathetic strings ----
class SympCf { d = [0, 0, 0]; h = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; cin = 0; on = 0; }
class Symp {
  s = new Str();
  line = Array.from({ length: NSYMP }, () => new Int16Array(YLINE));
  dcx = 0; dcy = 0; dce = 0;
  wp = 0; yl = 0;
  key = [0, 0, 0, 0, 0, 0];
  cf = new SympCf();
}

function sympBlock(Y: Symp, f: number[], brightness: number, damping: number, amount: number): void {
  const Bk = Y.cf;
  let b = m(brightness, 131072 - brightness, 16);
  const dd = 16384 + m(damping, 47186, 16);
  if (Y.key[0] === (f[0] | 0) && Y.key[1] === (f[1] | 0) && Y.key[2] === (f[2] | 0) && Y.key[3] === brightness && Y.key[4] === damping && Y.key[5] === amount) return;
  Y.key = [f[0] | 0, f[1] | 0, f[2] | 0, brightness, damping, amount];
  b = m(b, 131072 - b, 16);
  b = 32768 + (b >> 1);
  const lfd = m(dd, 131072 - dd, 16);
  const k8 = pxExp2(-8 * lfd) | 0;
  Bk.cin = amount >> 4;
  Bk.on = 0;
  for (let k = 0; k < NSYMP; k++) {
    if (f[k] < 65536) continue;
    let p = f[k] >= 0x40000000 ? 0 : Number((1n << 47n) / B(f[k]));
    while (p > (YLINE - 4) * 65536) p = Math.floor(p / 2);
    p -= 65536 - b;
    if (p < 2 * 65536) continue;
    const e = u32(((((B(p) * 27826874n) >> 32n) * B(k8 >>> 0)) >> 16n));
    const c = e > 15 * 65536 ? 0 : (pxExp2(-(e | 0)) << 8) | 0;
    const cc = c > 16775500 ? 16775500 : c;
    const fr = p & 0xffff;
    Bk.d[k] = p >>> 16;
    Bk.h[k][0] = m(cc, m(b, 65536 - fr, 16), 16);
    Bk.h[k][1] = m(cc, m(b, fr, 16) + m(65536 - b, 65536 - fr, 16), 16);
    Bk.h[k][2] = m(cc, m(65536 - b, fr, 16), 16);
    Bk.on |= 1 << k;
  }
}

function sympRun(Y: Symp, input: Int32Array, out: Int32Array, n: number): void {
  const Bk = Y.cf;
  let dcx = Y.dcx, dcy = Y.dcy, dce = Y.dce, yl = Y.yl;
  const x = new Int32Array(16), acc = new Int32Array(16);
  if (n > 32) n = 32;
  const mm = n >> 1;
  for (let i = 0; i < mm; i++) {
    const v = m(input[2 * i] + input[2 * i + 1], Bk.cin, 16);
    const [q, r] = acc30(1070617000, dcy, dce);
    dcy = (v - dcx + q) | 0;
    dce = r;
    dcx = v;
    x[i] = (dcy + 128) >> 8;
    acc[i] = 0;
  }
  for (let k = 0; k < NSYMP; k++) {
    const l = Y.line[k];
    let wp = Y.wp;
    const d = Bk.d[k];
    const h0 = Bk.h[k][0], h1 = Bk.h[k][1], h2 = Bk.h[k][2];
    if (!((Bk.on >> k) & 1)) continue;
    for (let i = 0; i < mm; i++) {
      const t = wp + d;
      const s = h0 * l[t & YMASK] + h1 * l[(t + 1) & YMASK] + h2 * l[(t + 2) & YMASK];
      const y = clamp((s < 0 ? Math.floor((s + 0xffffff) / 16777216) : Math.floor(s / 16777216)) + x[i], -32767, 32767);
      l[wp] = y;
      acc[i] += y;
      wp = (wp - 1) & YMASK;
    }
  }
  for (let i = 0; i < mm; i++) {
    out[2 * i] = input[2 * i] + ((yl + acc[i]) << 7);
    out[2 * i + 1] = input[2 * i + 1] + (acc[i] << 8);
    yl = acc[i];
  }
  if (n & 1) out[n - 1] = input[n - 1] + (yl << 8);
  Y.wp = (Y.wp - mm) & YMASK;
  Y.yl = yl; Y.dcx = dcx; Y.dcy = dcy; Y.dce = dce;
}

// ---- the engine ----
const PM_MODAL = 0, PM_STRING = 1, PM_MEMB = 2, PM_SYMP = 3, PM_COUNT = 4;
const PHYS_POLY = 3;
const GAIN = [28000, 12000, 90000, 12000];
const N_MODEL = ["MODAL", "STRNG", "MEMB", "SYMP"];
const N_CHORD = ["OCT", "5TH", "4TH", "MAJ", "MIN", "SUS", "7TH", "ROOT"];
const D_HARM: ParamDesc = { label: "HARM", fmt: F.PCT, min: 0, max: 127, def: 64 };
const D_BEND: ParamDesc = { label: "BEND", fmt: F.PCT, min: 0, max: 127, def: 0 };
const D_CHRD: ParamDesc = { label: "CHRD", fmt: F.INT, min: 0, max: 127, def: 64, names: N_CHORD };
const D_SYMP: ParamDesc = { label: "SYMP", fmt: F.PCT, min: 0, max: 127, def: 20 };
const D_BUZZ: ParamDesc = { label: "BUZZ", fmt: F.PCT, min: 0, max: 127, def: 0 };
const DESC: (ParamDesc | undefined)[][] = [
  [], [],
  [undefined, D_HARM, undefined, undefined, undefined, undefined, D_BEND, undefined],
  [undefined, D_CHRD, undefined, undefined, D_SYMP, undefined, D_BUZZ, undefined],
];
const CHORDS = [[-1200, 1200, 2400], [700, 1200, 1900], [500, 1200, 1700], [400, 700, 1200], [300, 700, 1200], [200, 700, 1400], [400, 700, 1000]];
const DETUNE = [1, -1, 0];

class Slot {
  model = 0;
  modal = new Modal();
  str = new Str();
  symp = new Symp();
}

const slots = new WeakMap<Track, Slot[]>();
function slotOf(t: Track, v: EngVoice): Slot | undefined {
  const i = t.v.indexOf(v);
  if (i < 0 || i >= PHYS_POLY) return undefined;
  let a = slots.get(t);
  if (!a) { a = Array.from({ length: PHYS_POLY }, () => new Slot()); slots.set(t, a); }
  return a[i];
}

/** Seeds: one shared xorshift (Felucca's rng()). */
const rngState = new Uint32Array([0x6a09e667]);
const rng = (): number => rand(rngState, 0);

function reset(S: Slot, md: number, seed: number): void {
  S.modal = new Modal();
  S.str = new Str();
  S.symp = new Symp();
  S.model = md;
  seed = (seed | 1) >>> 0;
  switch (md) {
    case PM_STRING:
      S.str.rng[0] = seed;
      S.str.src = 1 << 30;
      break;
    case PM_SYMP:
      S.symp.s.rng[0] = seed;
      S.symp.s.src = 1 << 30;
      break;
    default:
      S.modal.rng[0] = seed;
  }
}

function noteOn(t: Track, v: EngVoice): void {
  const S = slotOf(t, v);
  const md = t.p[P_E0] % PM_COUNT;
  if (!S) return;
  if ((!v.env && !v.envOut) || S.model !== md) reset(S, md, rng());
  if (md === PM_MODAL || md === PM_MEMB) S.modal.trig = 1;
  else if (md === PM_SYMP) S.symp.s.trig = 1;
  else S.str.trig = 1;
}

function sympPitches(t: Track, m_: Vmod, f: number[]): void {
  const c = t.p[P_E1] >> 4;
  for (let k = 0; k < NSYMP; k++) {
    let p16 = DETUNE[k];
    p16 += c < 7 ? m_.pitch16 + ((CHORDS[c][k] * 41) >> 8) : (48 + t.p[P_ROOT] + (k === 1 ? 7 : k === 2 ? 12 : 0)) * 16;
    f[k] = pitchInc(clamp(p16, 0, 2047));
  }
}

const y = new Int32Array(CTL), ax = new Int32Array(CTL);
const mb = new ModalBlk(), sb = new StrBlk();
const fs3 = [0, 0, 0];

function render(t: Track, v: EngVoice, out: Int32Array, n: number, m_: Vmod): void {
  const p = t.p;
  const S = slotOf(t, v);
  const md = p[P_E0] % PM_COUNT;
  const f0 = m_.inc;
  const strc = p[P_E1] * 516;
  const brit = clamp(p[P_E2] * 516 + m_.cutoff * 2, 0, 65536);
  const damp = p[P_E3] * 516, pos = p[P_E4], exc = p[P_E7] * 258;
  const bow = p[P_E6] * 206;
  const acc = clamp(p[P_E5] * v.vel * 4, 0, 65536);
  const g = GAIN[md];
  if (!S) return;
  if (n > CTL) n = CTL;
  if (S.model !== md) reset(S, md, rng());
  switch (md) {
    case PM_MODAL:
      modalBlock(mb, S.modal, f0, strc, brit, damp, acc, pos * 129, bow);
      modalRun(mb, S.modal, y, ax, n);
      break;
    case PM_MEMB:
      membBlock(mb, S.modal, f0, strc, brit, damp, acc, pos * 516, p[P_E6] * 6192);
      modalRun(mb, S.modal, y, ax, n);
      break;
    case PM_STRING:
      stringBlock(sb, S.str, f0, strc, brit, damp, acc, bow, pos * 516);
      stringExcite(sb, S.str, ax, n);
      stringRun(sb, S.str, ax, y, n);
      break;
    default:
      sympPitches(t, m_, fs3);
      stringBlock(sb, S.symp.s, f0, 16384 - p[P_E6] * 129, brit, damp, acc, 0, 0);
      stringExcite(sb, S.symp.s, ax, n);
      stringRun(sb, S.symp.s, ax, y, n);
      sympBlock(S.symp, fs3, brit, damp, pos * 516);
      sympRun(S.symp, y, y, n);
      break;
  }
  for (let i = 0; i < n; i++) {
    let s = m(y[i] + m(ax[i], exc, 15), g, 20);
    let a = s < 0 ? -s : s;
    if (a > 24000) {
      a = 24000 + (softclip(clamp(a - 24000, 0, 1 << 20) * 2) >> 1);
      s = s < 0 ? -a : a;
    }
    out[i] += voiceAmp(s, m_, i) * 2;
  }
}

export const ENG_PHYS: EngineDef = {
  name: "PHYS",
  pageTitle: ["BODY", "EXCT"],
  edit: [
    { label: "MODEL", fmt: F.ENUM, min: 0, max: PM_COUNT - 1, def: 0, names: N_MODEL },
    { label: "STRC", fmt: F.PCT, min: 0, max: 127, def: 64 },
    { label: "BRIT", fmt: F.PCT, min: 0, max: 127, def: 80 },
    { label: "DAMP", fmt: F.PCT, min: 0, max: 127, def: 80 },
    { label: "POS", fmt: F.PCT, min: 0, max: 127, def: 20 },
    { label: "ACC", fmt: F.PCT, min: 0, max: 127, def: 90 },
    { label: "BOW", fmt: F.PCT, min: 0, max: 127, def: 0 },
    { label: "EXC", fmt: F.PCT, min: 0, max: 127, def: 0 },
  ],
  knob: [P_E1, P_E2, P_E3, P_E4],
  keep: 0,
  poly: PHYS_POLY,
  noteOn,
  render,
  desc(t, k) {
    return k < 8 ? DESC[t.p[P_E0] % PM_COUNT][k] : undefined;
  },
};
