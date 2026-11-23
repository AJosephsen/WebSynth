// Port of Felucca's fx.c (GPL-3.0-only): per-track DIST, the three shared buses (chorus, tempo delay and a reverb
// of three models: ROOM, SPRING, HALL) and the master limiter. Integer arithmetic as in the original; the buses
// are mono, HALL adds a stereo difference. See NOTICE.
import { clamp, mulq15, mulq16, oscSine, softclip } from "../engines/dsp";
import { CTL, FS } from "../engines/types";
import { LFO_INC } from "./tables";

const DLY_LEN = 65536;
const CHO_LEN = 2048;
const REV_COMB = [1116, 1188, 1277, 1356];
const REV_AP = [556, 441];
const SP_LEN = 4096, SP_MASK = SP_LEN - 1, SP_N = 10, SP_A = 2867;
const HL_NL = 8, HL_NAP = 2, HL_NC = CTL / 2, HL_MOD = 8, HL_LPM = 0x69, HL_LOUD = 32, HL_OUT = 4;
const HL_LEN = [467, 509, 547, 593, 631, 673, 709, 743];
const HL_AP = [131, 307];
const HL_APG = [11469, 10240];
const HL_LFO = Math.floor(((0.37 * CTL) / FS) * 4294967296.0);
const THR_FB = 22938;
const DIV_DEN = [1, 2, 4, 8, 3, 6];
const DIV_DOT = [2, 3, 1];

/** The song's global effect settings (Felucca's G_* parameters). */
export interface FxSettings {
  bpm: number;
  dtime: number; // N_DTIME index: 1/4 1/8 1/16 1/32 8T 16T 1/2 1/1 2BAR 4BAR 1/8D 1/16D 1/4D
  dfdbk: number; // 0..120
  dcolor: number; // 0..127
  dmix: number; // 0..127
  rtype: number; // 0 ROOM, 1 SPRING, 2 HALL
  rsize: number; // 0..127
  rdamp: number; // 0..127
  crate: number; // 0..127
  cdepth: number; // 0..127
}

export const DTIME_NAMES = ["1/4", "1/8", "1/16", "1/32", "8T", "16T", "1/2", "1/1", "2BAR", "4BAR", "1/8D", "1/16D", "1/4D"];
export const RTYPE_NAMES = ["ROOM", "SPRING", "HALL"];

export const defaultFx = (): FxSettings => ({ bpm: 120, dtime: 1, dfdbk: 60, dcolor: 70, dmix: 90, rtype: 2, rsize: 90, rdamp: 60, crate: 40, cdepth: 60 });

const shTz = (m: number, sh: number): number => (m + ((m >> 31) & ((1 << sh) - 1))) >> sh;

/** 2^-x, x Q16 (0 .. 16): Q15. */
function exp2Neg(x: number): number {
  const i = x >>> 16;
  const u = 32768 - ((x & 0xffff) >>> 1);
  let p = 2579;
  p = Math.floor((p * u) / 32768) + 7409;
  p = Math.floor((p * u) / 32768) + 22780;
  p = Math.floor((p * u) / 32768) + 32768;
  return i < 15 ? p >>> (i + 1) : 0;
}

/** The chorus, delay and reverb buses (state of fx.c's `fx` and `hl`). */
export class FxBus {
  private dlyBuf = new Int16Array(DLY_LEN);
  private choBuf = new Int16Array(CHO_LEN);
  private revComb = new Int16Array(REV_COMB.reduce((a, b) => a + b, 0));
  private revU = new ArrayBuffer(1996); // ROOM's allpasses (int16 x 997) / SPRING's allpass chain (int32 x 498)
  private revAp = new Int16Array(this.revU, 0, 997);
  private sp = new Int32Array(this.revU, 0, 498);
  private dlyW = 0; private choW = 0; private choPh = 0; private dlyLp = 0;
  private combI = [0, 0, 0, 0]; private apI = [0, 0];
  private combLp = [0, 0, 0, 0];
  private rtype = 0;
  private spW = 0; private spLp = 0; private spHp = 0; private spHe = 0; private spSize = 0; private spPh = 0;
  // HALL
  private hI = new Array<number>(HL_NL).fill(0);
  private hD = [0, 0];
  private hLp = new Array<number>(HL_NL).fill(0);
  private hLe = new Array<number>(HL_NL).fill(0);
  private hX = 0; private hM = 0; private hS = 0; private hHp = 0; private hHe = 0;
  private hG = new Array<number>(HL_NL).fill(0);
  private hSz = 0;
  private hPh = 0;
  side = false;
  readonly sd = new Int32Array(CTL);
  private bx = new Int32Array(HL_NC);
  private hl = new Int32Array(HL_NC);
  private hr = new Int32Array(HL_NC);
  private hy = Array.from({ length: HL_NL }, () => new Int16Array(HL_NC));
  private scratch = new Int32Array(CTL);
  /** ECHO THROW: extra delay feedback share (Q15), 0 = off. */
  throwAmount = 0;

  private delaySamples(s: FxSettings): number {
    const bpm = s.bpm >= 40 ? s.bpm : 120;
    const quarter = Math.floor((FS * 60) / bpm);
    const d = s.dtime;
    let n: number;
    if (d - 10 >= 0 && d - 10 < 3) n = (quarter * 3) >> DIV_DOT[d - 10];
    else n = d < 6 ? Math.floor(quarter / DIV_DEN[d]) : d < 10 ? quarter << (d - 5) : Math.floor(quarter / DIV_DEN[d % 6]);
    return n < 16 ? 16 : n >= DLY_LEN ? DLY_LEN - 1 : n;
  }

  private revRoom(s: FxSettings, revIn: Int32Array, out: Int32Array, n: number): void {
    const size = 25000 + s.rsize * 50;
    const damp = 32767 - s.rdamp * 200;
    for (let i = 0; i < n; i++) {
      let a = 0;
      let co = 0;
      const input = mulq15(revIn[i], 2580);
      for (let k = 0; k < 4; k++) {
        const o = this.revComb[co + this.combI[k]];
        this.combLp[k] = o + mulq15(this.combLp[k] - o, 32767 - damp);
        this.revComb[co + this.combI[k]] = clamp(input + mulq15(this.combLp[k], size), -32768, 32767);
        if (++this.combI[k] >= REV_COMB[k]) this.combI[k] = 0;
        a += o;
        co += REV_COMB[k];
      }
      let ao = 0;
      for (let k = 0; k < 2; k++) {
        const o = this.revAp[ao + this.apI[k]];
        const v = a + (o >> 1);
        this.revAp[ao + this.apI[k]] = clamp(v, -32768, 32767);
        a = o - a;
        if (++this.apI[k] >= REV_AP[k]) this.apI[k] = 0;
        ao += REV_AP[k];
      }
      out[i] += a;
    }
  }

  private revSpring(s: FxSettings, revIn: Int32Array, out: Int32Array, n: number): void {
    const sz = s.rsize;
    const g = 19661 + sz * 85;
    const kl = 26000 - s.rdamp * 160;
    const len = (1323 + ((sz * 1323) >> 7)) << 8;
    const ln = this.revComb;
    const ap = this.sp;
    if (!this.spSize) this.spSize = len;
    this.spSize += clamp(len - this.spSize, -256, 256);
    const L = this.spSize >> 8;
    this.spPh = (this.spPh + 2 * LFO_INC[24]) >>> 0;
    const w = (this.spSize >> 1) + ((oscSine(this.spPh) * 3) >> 8);
    const L2 = w >> 8;
    const f = w & 255;
    const L3 = (L * 3) >> 2;
    for (let i = 0; i < n; i++) {
      const wp = this.spW;
      const j = (wp & 3) * (SP_N + 1);
      let x = mulq15(revIn[i], 2580);
      const r = ln[(wp - L) & SP_MASK];
      const t0 = ln[(wp - L2) & SP_MASK];
      const t1 = ln[(wp - L2 - 1) & SP_MASK];
      this.spLp += mulq15(r - this.spLp, kl);
      let o = Math.imul(this.spLp, g);
      x += (o + ((o >> 31) & 32767)) >> 15;
      o = x - this.spHp + this.spHe;
      this.spHe = o & 63;
      this.spHp += o >> 6;
      x -= this.spHp;
      let p = ap[j];
      ap[j] = x;
      for (let k = 1; k <= SP_N; k++) {
        const v = Math.imul(x - ap[j + k], SP_A);
        o = ap[j + k];
        x = ((v + ((v >> 31) & 4095)) >> 12) + p;
        p = o;
        ap[j + k] = x;
      }
      ln[wp & SP_MASK] = clamp(x, -32768, 32767);
      this.spW = (wp + 1) & 0xffff;
      out[i] += (t0 + (((t1 - t0) * f) >> 8)) * 4 + ln[(wp - L3) & SP_MASK] * 2;
    }
  }

  private hallGains(sz: number): void {
    const q = exp2Neg(Math.floor((sz * 65536) / 30));
    for (let k = 0; k < HL_NL; k++) {
      const g = exp2Neg(Math.floor((HL_LEN[k] * 59 * q) / 32768));
      this.hG[k] = Math.floor(((g > 32440 ? 32440 : g) * 6193) / 32768);
    }
    this.hSz = sz + 1;
  }

  private revHall(s: FxSettings, revIn: Int32Array, out: Int32Array): void {
    const kd = 32767 - s.rdamp * 180;
    let xp = this.hX, hp = this.hHp, he = this.hHe, mp = this.hM, sp = this.hS;
    if (this.hSz !== s.rsize + 1) this.hallGains(s.rsize);
    for (let i = 0; i < HL_NC; i++) {
      let x = (xp + 2 * revIn[2 * i] + revIn[2 * i + 1]) >> 2;
      xp = revIn[2 * i + 1];
      x = mulq15(clamp(x, -262143, 262143), 2580);
      const v = x - hp + he;
      he = v & 31;
      hp += v >> 5;
      this.bx[i] = x - hp;
    }
    this.hX = xp; this.hHp = hp; this.hHe = he;
    let a = 0; // offset into revAp
    for (let k = 0; k < HL_NAP; k++) {
      let d = this.hD[k];
      for (let st = 0; st < HL_NC;) {
        const m = Math.min(HL_AP[k] - d, HL_NC - st);
        // allpass diffuser over bx[st .. st+m) from revAp[a + d ..]
        for (let i = 0; i < m; i++) {
          const y = this.revAp[a + d + i];
          const v = this.bx[st + i] + shTz(Math.imul(y, HL_APG[k]), 14);
          this.revAp[a + d + i] = clamp(v, -32768, 32767);
          this.bx[st + i] = y - ((Math.imul(v, HL_APG[k]) + 8192) >> 14);
        }
        st += m;
        d = d + m >= HL_AP[k] ? 0 : d + m;
      }
      this.hD[k] = d;
      a += HL_AP[k];
    }
    this.hPh = (this.hPh + HL_LFO) >>> 0;
    const b = this.revComb;
    let bo = 0;
    for (let k = 0; k < HL_NL; k++) {
      const g = this.hG[k];
      let f = 0;
      let d: number;
      const lowpassed = (HL_LPM >> k) & 1;
      if (lowpassed) {
        d = this.hI[k];
      } else {
        const r = (((HL_MOD + 2) << 8) + ((oscSine(((Math.imul(this.hPh, 1 + (k & 1)) + Math.imul(k, 0x2c000000)) >>> 0)) * HL_MOD) >> 7)) >>> 0;
        f = r & 255;
        d = this.hI[k] + (r >>> 8);
        d = d >= HL_LEN[k] ? d - HL_LEN[k] : d;
      }
      let s2 = d + (HL_LEN[k] >>> 1);
      s2 = s2 >= HL_LEN[k] ? s2 - HL_LEN[k] : s2;
      const lo = Math.abs(b[bo + d]) + Math.abs(b[bo + s2]) < HL_LOUD;
      const y = this.hy[k];
      for (let st = 0; st < HL_NC;) {
        const m = Math.min(HL_LEN[k] - d, HL_NC - st);
        if (lowpassed) {
          let l = this.hLp[k], r = this.hLe[k];
          for (let i = 0; i < m; i++) {
            const e = Math.imul(b[bo + d + i] - l, kd) + r;
            r = e & 32767;
            l += e >> 15;
            y[st + i] = lo ? shTz(Math.imul(l, g), 14) : (Math.imul(l, g) + 8192) >> 14;
          }
          this.hLp[k] = l;
          this.hLe[k] = r;
        } else if (lo) {
          for (let i = 0; i < m; i++) {
            const b0 = b[bo + d + i], b1 = b[bo + d + i + 1];
            y[st + i] = shTz(Math.imul(b0 + (((b1 - b0) * f + 128) >> 8), g), 14);
          }
        } else {
          for (let i = 0; i < m; i++) {
            const b0 = b[bo + d + i], b1 = b[bo + d + i + 1];
            y[st + i] = (Math.imul(b0 + (((b1 - b0) * f + 128) >> 8), g) + 8192) >> 14;
          }
        }
        st += m;
        d = d + m >= HL_LEN[k] ? 0 : d + m;
      }
      bo += HL_LEN[k] + 1;
    }
    const Y = this.hy;
    for (let i = 0; i < HL_NC; i++) {
      let y0 = Y[0][i];
      const y1 = Y[1][i], y2 = Y[2][i], y3 = Y[3][i], y4 = Y[4][i], y5 = Y[5][i], y6 = Y[6][i], y7 = Y[7][i];
      const x = this.bx[i];
      this.hl[i] = y0 + y3 + y4 - y7;
      this.hr[i] = y1 + y2 + y5 + y6;
      const t = y1 + y2 + y3 + y4 + y5 + y6 + y7;
      const p0 = y2 + y3 + y5, p1 = y3 + y4 + y6, p2 = y4 + y5 + y7, p3 = y5 + y6 + y1;
      const p4 = y6 + y7 + y2, p5 = y7 + y1 + y3, p6 = y1 + y2 + y4;
      y0 += t;
      Y[0][i] = clamp(t + x, -32768, 32767);
      Y[1][i] = clamp(2 * p0 + y1 - y0 + x, -32768, 32767);
      Y[2][i] = clamp(2 * p1 + y2 - y0 + x, -32768, 32767);
      Y[3][i] = clamp(2 * p2 + y3 - y0 + x, -32768, 32767);
      Y[4][i] = clamp(2 * p3 + y4 - y0 + x, -32768, 32767);
      Y[5][i] = clamp(2 * p4 + y5 - y0 + x, -32768, 32767);
      Y[6][i] = clamp(2 * p5 + y6 - y0 + x, -32768, 32767);
      Y[7][i] = clamp(2 * p6 + y7 - y0 - x, -32768, 32767);
    }
    bo = 0;
    for (let k = 0; k < HL_NL; k++) {
      let d = this.hI[k];
      for (let st = 0; st < HL_NC;) {
        const m = Math.min(HL_LEN[k] - d, HL_NC - st);
        for (let i = 0; i < m; i++) b[bo + d + i] = Y[k][st + i];
        if (!d) b[bo + HL_LEN[k]] = b[bo];
        st += m;
        d = d + m >= HL_LEN[k] ? 0 : d + m;
      }
      this.hI[k] = d;
      bo += HL_LEN[k] + 1;
    }
    for (let i = 0; i < HL_NC; i++) {
      const mm = (this.hl[i] + this.hr[i]) * HL_OUT;
      const ss = (this.hl[i] - this.hr[i]) * HL_OUT;
      out[2 * i] += (mp + mm) >> 1;
      out[2 * i + 1] += mm;
      this.sd[2 * i] = (sp + ss) >> 1;
      this.sd[2 * i + 1] = ss;
      mp = mm;
      sp = ss;
    }
    this.hM = mp;
    this.hS = sp;
    this.side = true;
  }

  private revClear(): void {
    this.revComb.fill(0);
    this.revAp.fill(0);
    this.combLp.fill(0);
    this.hLp.fill(0);
    this.hLe.fill(0);
    this.spLp = this.spHp = this.spHe = 0;
    this.hX = this.hM = this.hS = this.hHp = this.hHe = 0;
  }

  private reverb(s: FxSettings, model: number, revIn: Int32Array, out: Int32Array, n: number): void {
    if (model === 2) this.revHall(s, revIn, out);
    else if (model) this.revSpring(s, revIn, out, n);
    else this.revRoom(s, revIn, out, n);
  }

  private revSwitch(s: FxSettings, revIn: Int32Array, wet: Int32Array, n: number, rt: number): void {
    const t = this.scratch;
    let g = 65536;
    const d = Math.trunc(65536 / n);
    t.fill(0, 0, n);
    this.reverb(s, this.rtype, revIn, t, n);
    for (let i = 0; i < n; i++, g -= d) {
      wet[i] += mulq16(t[i], g);
      this.sd[i] = mulq16(this.sd[i], g);
    }
    this.revClear();
    this.rtype = rt;
  }

  /** Processes the three buses for one block of n (= CTL) samples; wet is written. */
  process(s: FxSettings, choIn: Int32Array, dlyIn: Int32Array, revIn: Int32Array, wet: Int32Array, n: number): void {
    const dl = this.delaySamples(s);
    let fb = s.dfdbk * 230;
    const col = 2000 + s.dcolor * 240;
    const dmix = s.dmix * 258;
    const cdepth = s.cdepth * 6;
    const cinc = Math.floor(LFO_INC[s.crate & 127] / CTL);
    if (this.throwAmount && fb < THR_FB) fb += mulq16(THR_FB - fb, this.throwAmount << 1);
    for (let i = 0; i < n; i++) {
      let y = 0;
      this.choBuf[this.choW & (CHO_LEN - 1)] = clamp(choIn[i] >> 1, -32768, 32767);
      this.choPh = (this.choPh + cinc) >>> 0;
      const r = (400 << 8) + (((oscSine(this.choPh) + 32768) * cdepth) >> 8);
      const ri = r >>> 8;
      const f = r & 255;
      const c0 = this.choBuf[(this.choW - ri) & (CHO_LEN - 1)];
      const c1 = this.choBuf[(this.choW - ri - 1) & (CHO_LEN - 1)];
      y += (c0 + (((c1 - c0) * f) >> 8)) << 1;
      this.choW = (this.choW + 1) >>> 0;
      const x = this.dlyBuf[(this.dlyW - dl) & (DLY_LEN - 1)];
      this.dlyLp += mulq15(x - this.dlyLp, col);
      this.dlyBuf[this.dlyW & (DLY_LEN - 1)] = clamp((dlyIn[i] >> 1) + mulq15(this.dlyLp, fb), -32768, 32767);
      this.dlyW = (this.dlyW + 1) >>> 0;
      y += mulq15(x << 1, dmix);
      wet[i] = y;
    }
    const rt = s.rtype === 1 || s.rtype === 2 ? s.rtype : 0;
    this.side = false;
    if (rt !== this.rtype) this.revSwitch(s, revIn, wet, n, rt);
    else this.reverb(s, rt, revIn, wet, n);
  }

  /** HALL's stereo difference: added to the left and taken from the right of the dry mix. */
  sideMix(l: Int32Array, r: Int32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      l[i] += this.sd[i];
      r[i] -= this.sd[i];
    }
  }
}

/** Per-track distortion state. */
export class Dist {
  hp = 0; lp1 = 0; lp2 = 0;
  /** DIST over b[0 .. n) with amount d (0 = off, states kept). */
  process(d: number, b: Int32Array, n: number): void {
    if (!d) return;
    const g = 4096 + d * d * 2;
    const k = 32000 - d * 95;
    const mk = 30000 - d * 120;
    const bias = 2400;
    const b0 = softclip(bias);
    for (let i = 0; i < n; i++) {
      let x = b[i];
      this.hp += (x - this.hp + 64) >> 7;
      x = clamp(x - this.hp, -230000, 230000);
      const y = softclip(((Math.imul(x >> 2, g)) >> 10) + bias) - b0;
      this.lp1 += mulq15(y - this.lp1, k);
      this.lp2 += mulq15(this.lp1 - this.lp2, k);
      b[i] = mulq15(this.lp2, mk);
    }
  }
}

const LIM_T = 18000;

/** The master section: DC blocker, peak limiter, soft clipper. */
export class Master {
  private limEnv = LIM_T;
  private dcL = 0; private dcR = 0; private dceL = 0; private dceR = 0;

  private static dcBlock(x: number, dc: number, err: number): [number, number, number] {
    const e = x * 64 - dc + err;
    const d = e >> 12;
    const nerr = e - d * 4096;
    const ndc = dc + d;
    return [x - ((ndc + 32) >> 6), ndc, nerr];
  }

  /** Processes one stereo sample pair in place (Q15-scale integers). */
  process(l: number, r: number): [number, number] {
    let o = Master.dcBlock(l, this.dcL, this.dceL);
    l = o[0]; this.dcL = o[1]; this.dceL = o[2];
    o = Master.dcBlock(r, this.dcR, this.dceR);
    r = o[0]; this.dcR = o[1]; this.dceR = o[2];
    const a = Math.max(Math.abs(l), Math.abs(r));
    if (a > this.limEnv) this.limEnv += (a - this.limEnv) >> 2;
    else if (this.limEnv > LIM_T) this.limEnv -= ((this.limEnv - LIM_T) >> 12) + 1;
    if (this.limEnv > LIM_T) {
      const g = Math.floor((LIM_T * 32768) / this.limEnv);
      l = Math.imul(l >> 4, g) >> 11;
      r = Math.imul(r >> 4, g) >> 11;
    }
    return [softclip(l), softclip(r)];
  }
}
