// Port of Felucca's INSERT effect (fx.c track_insert, GPL-3.0-only): one effect per track after DIST, with a dry/wet
// MIX: SOFT HARD FOLD FUZZ drives, CRUSH, PHASER, FLANGER, CHORUS. See NOTICE.
import { clamp, mulq15, mulq16, oscSine, softclip } from "../engines/dsp";
import { LEVEL_Q12 } from "../engines/felucca-tables";
import { SVF_G } from "../engines/tables";
import { CTL } from "../engines/types";
import { LFO_INC } from "./tables";

export const IT_OFF = 0, IT_SOFT = 1, IT_HARD = 2, IT_FOLD = 3, IT_FUZZ = 4, IT_CRUSH = 5, IT_PHASER = 6, IT_FLANGER = 7, IT_CHORUS = 8, IT_N = 9;
export const INSERT_NAMES = ["OFF", "SOFT", "HARD", "FOLD", "FUZZ", "CRUSH", "PHASR", "FLANG", "CHOR"];

/** The insert's settings: type, dry/wet MIX and the three values A B C (what they mean depends on the type). */
export interface InsertSetup { itype: number; imix: number; ia: number; ib: number; ic: number }
export const defaultInsert = (): InsertSetup => ({ itype: 0, imix: 127, ia: 64, ib: 96, ic: 96 });

/** Labels of A B C for a type (Felucca's ins_desc). */
export function insertLabels(type: number): [string, string, string] {
  if (type <= 0 || type >= IT_N) return ["INS A", "INS B", "INS C"];
  if (type < 5) return ["DRIVE", "TONE", "LEVEL"];
  if (type === 5) return ["BITS", "RATE", "LPF"];
  return ["RATE", "DEPTH", "FDBK"];
}

const IL_LEN = 256;
const PH_ST = 4;
const SL_SLOPE = 32768 / 128;
const HOLD = [64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1];
const PH_A = [
  -16038, -15998, -15955, -15906, -15853, -15793, -15727, -15653, -15572, -15481, -15381, -15270, -15147, -15012,
  -14862, -14696, -14514, -14313, -14092, -13849, -13582, -13290, -12970, -12621, -12240, -11825, -11375, -10886,
  -10356, -9784, -9166, -8500, -7783,
];

const mixq = (m: number): number => (m >= 127 ? 32768 : m <= 0 ? 0 : m * 258);
const lpk = (c: number): number => {
  const g = SVF_G[clamp(c, 0, 127)];
  return Math.floor((g * 65536) / (4096 + g));
};
const pfMix = (x: number, y: number, w: number): number => (w === 32768 ? y : (x + mulq16(y - x, (w << 1) >>> 0)) | 0);
const pfTri = (q: number): number => {
  const t = q >>> 16;
  return t < 32768 ? t << 1 : (65535 - t) << 1;
};
const bitsSh = (a: number): number => 15 - (clamp(a, 0, 127) >> 3);

function shape(ty: number, v: number, sh: number): number {
  switch (ty) {
    case IT_SOFT: return softclip(v);
    case IT_HARD: return clamp(v, -24000, 24000);
    case IT_FOLD: {
      let u = (((v + 16384) >>> 0) & 0xffff) - 32768;
      u = 16384 - (u < 0 ? -u : u);
      return u + (u >> 1);
    }
    case IT_FUZZ: return v > 0 ? (v > 20000 ? 20000 : v) : softclip(v) >> 1;
    case IT_CRUSH: return sh ? ((v + (1 << (sh - 1))) >> sh) << sh : v;
    default: return v;
  }
}

/** One track's insert effect. */
export class Insert {
  private w = 0; private type = 0; private cnt = 0; private wp = 0; private ph = 0;
  private hp = 0; private lp1 = 0; private lp2 = 0; private dc = 0; private hold = 0;
  private px = new Int32Array(PH_ST); private py = new Int32Array(PH_ST); private fb = 0;
  private line = new Int16Array(IL_LEN);
  /** True while the effect still has something to do (call again even with the type off). */
  running = false;

  private clear(): void {
    this.w = 0; this.type = 0; this.cnt = 0; this.wp = 0; this.ph = 0;
    this.hp = this.lp1 = this.lp2 = this.dc = this.hold = 0;
    this.px.fill(0); this.py.fill(0); this.fb = 0;
    this.line.fill(0);
  }

  private drive(p: InsertSetup, b: Int32Array, n: number, tw: number): void {
    const ty = this.type;
    const crush = ty === IT_CRUSH;
    const sh = bitsSh(p.ia);
    const hold = HOLD[clamp(p.ib, 0, 127) >> 3];
    const a = p.ia;
    const g = 4096 + a * a * 3;
    const k = lpk(crush ? p.ic : p.ib);
    const lvl = crush ? 4096 : LEVEL_Q12[p.ic & 127];
    for (let i = 0; i < n; i++) {
      const x = b[i];
      let y: number;
      this.w += clamp(tw - this.w, -SL_SLOPE, SL_SLOPE);
      if (crush) {
        if (!this.cnt) {
          this.hold = shape(IT_CRUSH, clamp(x, -262144, 262143), sh);
          this.cnt = hold;
        }
        this.cnt--;
        y = this.hold;
      } else {
        this.hp += ((x << 8) - this.hp) >> 8;
        const v = clamp(x - (this.hp >> 8), -230000, 230000);
        y = shape(ty, Math.imul(v >> 3, g) >> 9, 0);
      }
      y <<= 4;
      let v = mulq16(y - this.lp1, k);
      y = v + this.lp1;
      this.lp1 = y + v;
      v = mulq16(y - this.lp2, k);
      y = v + this.lp2;
      this.lp2 = y + v;
      y = (y + 8) >> 4;
      if (!crush) {
        y = Math.imul(y, lvl) >> 12;
        this.dc += ((y << 8) - this.dc) >> 9;
        y -= this.dc >> 8;
      }
      b[i] = pfMix(x, y, this.w);
    }
  }

  private swept(p: InsertSetup, b: Int32Array, n: number, tw: number): void {
    const inc = Math.floor(LFO_INC[clamp(p.ia, 0, 127)] / CTL);
    const dep = clamp(p.ib, 0, 127);
    const c = clamp(p.ic, 0, 127);
    if (this.type === IT_PHASER) {
      const tr = pfTri((this.ph + (n >> 1) * inc) >>> 0);
      const q = (32768 + Math.trunc(((tr - 32768) * dep) / 127)) >>> 0;
      const a = PH_A[q >> 11] + (((PH_A[(q >> 11) + 1] - PH_A[q >> 11]) * (q & 2047)) >> 11);
      const fbk = c * 180;
      for (let i = 0; i < n; i++) {
        const x = b[i];
        const xs = clamp((x + 4) >> 3, -16383, 16383);
        let u = xs + ((Math.imul(this.fb, fbk) + 16384) >> 15);
        let y = u;
        this.w += clamp(tw - this.w, -SL_SLOPE, SL_SLOPE);
        for (let st = 0; st < PH_ST; st++) {
          y = clamp(this.px[st] + ((Math.imul(a, u - this.py[st]) + 8192) >> 14), -65535, 65535);
          this.px[st] = u;
          this.py[st] = y;
          u = y;
        }
        this.fb = clamp(y, -32767, 32767);
        y <<= 2;
        this.dc += ((y << 8) - this.dc) >> 9;
        b[i] = pfMix(x, (x >> 1) + y - (this.dc >> 8), this.w);
      }
      this.ph = (this.ph + Math.imul(n, inc)) >>> 0;
      return;
    }
    const chorus = this.type === IT_CHORUS;
    const fbk = c * (chorus ? 103 : 219);
    const dq = dep * 516;
    for (let i = 0; i < n; i++, this.ph = (this.ph + inc) >>> 0) {
      const x = b[i];
      let d: number;
      this.w += clamp(tw - this.w, -SL_SLOPE, SL_SLOPE);
      if (chorus) {
        d = ((140 << 16) + (Math.imul(oscSine(this.ph), dep * 50) >> 5)) >>> 0;
      } else {
        const tr = pfTri(this.ph);
        const sw = Math.floor((tr * tr) / 65536);
        d = ((11 << 16) + 209 * (Math.floor(((sw >>> 1) * dq) / 32768))) >>> 0;
      }
      const r0 = (this.wp - (d >>> 16)) & (IL_LEN - 1);
      const r1 = (r0 - 1) & (IL_LEN - 1);
      const fr = (d >>> 1) & 0x7fff;
      let v = this.line[r0] + (Math.imul(this.line[r1] - this.line[r0], fr) >> 15);
      this.line[this.wp] = clamp((x >> 2) + softclip(mulq15(v, fbk)), -32767, 32767);
      this.wp = (this.wp + 1) & (IL_LEN - 1);
      v <<= 1;
      this.dc += ((v << 8) - this.dc) >> 9;
      b[i] = pfMix(x, (x >> 1) + v - (this.dc >> 8), this.w);
    }
  }

  /** The insert over b[0 .. n): nothing while the type is OFF or MIX is 0 and faded. */
  process(p: InsertSetup, b: Int32Array, n: number): void {
    const ty = clamp(p.itype, 0, IT_N - 1);
    if (this.type !== ty && !this.w) this.type = ty;
    const tw = this.type === ty && ty ? mixq(p.imix) : 0;
    if (!this.w) {
      if (!tw) {
        this.running = false;
        return;
      }
      this.clear();
      this.type = ty;
    }
    if (this.type >= IT_PHASER) this.swept(p, b, n, tw);
    else this.drive(p, b, n, tw);
    this.running = this.w !== 0;
  }
}
