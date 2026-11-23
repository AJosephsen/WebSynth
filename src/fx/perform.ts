// The performance layer of Felucca's FX hold keys (perform.c, GPL-3.0-only): REPEAT / REVERSE, LPF, HPF, TAPE STOP, FREEZE,
// OCT UP / DN, FLANGER, PHASER, REV / ECHO THROW, the track mutes and the four knob macros. See NOTICE.
// Held effects are bits; the layer runs between the master level and the limiter, and is skipped (bit-identical) while idle.
import { clamp, mulq15, mulq16, oscSine, softclip } from "../engines/dsp";
import { LEVEL_Q12 } from "../engines/felucca-tables";
import { FS } from "../engines/types";

export const PF_SVF = new Int16Array([16349,35,0,16345,39,0,16341,43,0,16337,47,0,16332,52,0,16327,57,0,16321,63,0,16314,70,0,16307,77,0,16299,85,0,16290,94,1,16280,103,1,16269,114,1,16257,126,1,16244,139,1,16229,153,1,16213,169,2,16196,186,2,16176,205,3,16154,227,3,16130,250,4,16104,275,5,16075,303,6,16043,334,7,16007,368,8,15968,406,10,15925,447,13,15877,492,15,15824,541,19,15766,596,22,15702,655,27,15631,720,33,15553,791,40,15467,869,49,15372,953,59,15267,1046,72,15151,1146,87,15024,1255,105,14883,1374,127,14729,1502,153,14559,1640,185,14372,1790,223,14166,1950,268,13940,2121,323,13692,2304,388,13420,2499,465,13122,2704,557,12797,2921,667,12441,3147,796,12053,3382,949,11631,3624,1129,11173,3870,1341,10677,4119,1589,10140,4365,1879,9562,4605,2218,8940,4832,2612,8274,5040,3070,7563,5219,3602,6807,5359,4219,6006,5444,4934,5163,5456,5766,4282,5369,6733,3372,5149,7863,2449,4745,9190]);
export const PH_A = new Int16Array([-16038,-15998,-15955,-15906,-15853,-15793,-15727,-15653,-15572,-15481,-15381,-15270,-15147,-15012,-14862,-14696,-14514,-14313,-14092,-13849,-13582,-13290,-12970,-12621,-12240,-11825,-11375,-10886,-10356,-9784,-9166,-8500,-7783]);

export const PF_R8 = 0, PF_R16 = 1, PF_R32 = 2, PF_REV = 3, PF_LPF = 4, PF_HPF = 5, PF_TAPE = 6, PF_FRZ = 7, PF_OUP = 8, PF_ODN = 9,
  PF_FLG = 10, PF_PHS = 11, PF_RTHR = 12, PF_ETHR = 13, PF_M1 = 14, PF_N = 18;
export const PF_NFX = PF_M1;
export const NTRK = 4;
export const PF_NAMES = ["REPEAT 1/8", "REPEAT 1/16", "REPEAT 1/32", "REVERSE", "LPF", "HPF", "TAPE STOP", "FREEZE", "OCT UP", "OCT DN", "FLANGER", "PHASER", "REV THROW", "ECHO THROW"];

const bit = (e: number): number => 1 << e;
const PF_REPEAT = 0x7;
const PF_Q = PF_REPEAT | bit(PF_REV);
const PF_HARM = bit(PF_OUP) | bit(PF_ODN);
const PF_BUF = PF_REPEAT | bit(PF_REV) | bit(PF_TAPE) | bit(PF_FRZ) | PF_HARM;
const SL_LEN = 4096, SL_RAMP_LOG2 = 7, SL_RAMP = 128, SL_SLOPE = 32768 / SL_RAMP;
const PB_FRAMES = (NTRK * SL_LEN) / 2; // 8192
const PB_MAX = 2 * PB_FRAMES;
const PB_TAPE = 32000, PB_FREC = 4096, PB_GRAIN = 2048;
const HB_MASK = 4095, HB_BASE = 128, HB_FB = 269;
const PF_TOP = 63 << 8, PF_LOW = 14 << 8;
const BM_NONE = 0, BM_LOOP = 1, BM_TAPE = 2, BM_FRZ = 3, BM_HARM = 4;
const FL_LEN = 356, FL_MIN = 22, FL_MAX = 353, FL_FB = 16384;
const PH_ST = 4, PH_FB = 13107;
const THR_SLOPE = 64, THR_FB = 22938;
const PF_DEN = [2, 4, 8, 2];

export { THR_FB };

const pfMix = (x: number, y: number, w: number): number => (w === 32768 ? y : x + mulq16(y - x, (w << 1) >>> 0));
const pfTri = (q: number): number => {
  const t = q >>> 16;
  return t < 32768 ? t << 1 : (65535 - t) << 1;
};
let rngState = 0x2545f491;
export function resetPerformRng(): void { rngState = 0x2545f491; }
function rng(): number {
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return rngState >>> 0;
}

/** The layer's state and processing. */
export class Perform {
  // ---- settings (the main loop) ----
  latchOn = false;
  kill = false;
  solo = 0;
  /** The knob macros: FILTER -100..100, CRUSH 0..100, THROW 0..100, DEPTH 0..100. */
  readonly k = new Int8Array(4);
  /** The tempo and transport the layer follows (set by the engine every block). */
  bpm = 120;
  playing = false;
  // ---- keys ----
  held = 0;
  latched = 0;
  private readonly ord = new Uint32Array(PF_N);
  private seq = 0;
  // ---- state ----
  private ph = 0; private P = 0; private split = 0; act = 0; private act0 = 0;
  busy = false; private sync = false; muteMask = 0;
  private mode = BM_NONE; private src = PF_N; private next = PF_N; private rev = false;
  private state = 0; private odd = 0; private xrev = false;
  private len = 0; private wr = 0; private rp = 0; private xrp = 0; private xlen = 0; private xn = 0;
  private tv = 0; private dv = 0; private tpos = 0;
  private readonly gp = [0, 0]; private readonly gs = [0, 0];
  private hph = 0; private hinc = 0; private hfb = 0;
  private w = 0; private tw = 0; private hl = 0; private hr = 0;
  private lc = PF_TOP; private hc = 0; private la = 0; private ha = 0;
  private readonly lz = new Int32Array(4); private readonly hz = new Int32Array(4);
  private readonly lk = new Int16Array(3); private readonly hk = new Int16Array(3);
  private lt = 0; private ht = 0;
  private cw = 0; private cc = 0; private chl = 0; private chr = 0; private cn = 0;
  private td = 0;
  rw = 0; ew = 0; rw1 = 0; ew1 = 0; thr = false;
  readonly mg = [32768, 32768, 32768, 32768];
  private fw = 0; private pw = 0; private fwp = 0; private fn = 0;
  private readonly px = new Int32Array(2 * PH_ST); private readonly py = new Int32Array(2 * PH_ST); private readonly pfb = new Int32Array(2);
  private readonly flBuf = new Int16Array(FL_LEN * 2);
  private readonly buf = new Int16Array(NTRK * SL_LEN);

  /** Samples in a quarter note (fx.c beat_samples). */
  private beatSamples(): number {
    const bpm = this.bpm >= 40 ? this.bpm : 120;
    return Math.floor((FS * 60) / bpm);
  }
  private perfLen(e: number): number { return e <= PF_REV ? Math.floor(this.beatSamples() / PF_DEN[e]) : 0; }
  private avail(): number {
    let m = ~0;
    const b = this.beatSamples();
    for (let e = PF_R8; e <= PF_REV; e++) if (b > PB_MAX * PF_DEN[e]) m &= ~bit(e);
    return m;
  }

  /** A layer key down / up (e: PF_*). */
  press(e: number, down: boolean): void {
    if (e >= PF_N) return;
    if (this.latchOn) {
      if (down) { this.latched = (this.latched ^ bit(e)) >>> 0; this.ord[e] = ++this.seq; }
      else this.held = (this.held & ~bit(e)) >>> 0;
      return;
    }
    if (down) { this.held = (this.held | bit(e)) >>> 0; this.ord[e] = ++this.seq; }
    else this.held = (this.held & ~bit(e)) >>> 0;
  }

  /** Everything off (the menu, a dialog). */
  allOff(): void { this.held = 0; this.latched = 0; }

  /** The transport started: a 1/16 starts with it. */
  start(): void { this.ph = 0; this.sync = true; }

  private pick(a: number): number {
    let best = PF_N;
    a &= PF_BUF;
    for (let e = 0; e < PF_M1; e++) if (((a >>> e) & 1) && (best === PF_N || ((this.ord[e] - this.ord[best]) >>> 0) < 0x80000000)) best = e;
    return best;
  }

  private bufStart(e: number): void {
    this.src = e;
    this.next = PF_N;
    this.wr = this.rp = 0;
    this.odd = 0;
    this.xn = 0;
    if (e === PF_TAPE) {
      let t = this.beatSamples();
      this.mode = BM_TAPE;
      if (t > PB_TAPE) t = PB_TAPE;
      this.tv = 65536;
      this.dv = (Math.floor(65536 / t) + 1) >>> 0;
      this.tpos = 0;
    } else if (e === PF_OUP || e === PF_ODN) {
      this.mode = BM_HARM;
      this.len = 0;
      this.hph = 0;
      this.hinc = e === PF_OUP ? (0 - (1 << 21)) >>> 0 : 1 << 20;
      this.hfb = 0;
    } else if (e === PF_FRZ) {
      this.mode = BM_FRZ;
      this.gp[0] = 0;
      this.gp[1] = PB_GRAIN / 2;
      this.gs[0] = this.gs[1] = 0;
    } else {
      this.mode = BM_LOOP;
      this.state = 0;
      this.len = this.perfLen(e);
      this.rev = e === PF_REV;
    }
  }

  private bufSelect(e: number): void {
    if (e === this.src && this.next === PF_N) return;
    if (e !== PF_N && this.mode === BM_LOOP && this.state && e <= PF_REV && this.src !== PF_N && this.perfLen(e) <= 2 * this.wr) {
      this.xrp = this.rp;
      this.xlen = this.len;
      this.xrev = this.rev;
      this.xn = SL_RAMP;
      this.src = e;
      this.next = PF_N;
      this.len = this.perfLen(e);
      this.rev = e === PF_REV;
      this.rp = 0;
      return;
    }
    if (this.mode === BM_NONE || !this.w) {
      if (e === PF_N) { this.src = PF_N; this.next = PF_N; } else this.bufStart(e);
      return;
    }
    this.src = PF_N;
    this.next = e;
  }

  /** Each block, before the parts: what runs, the 1/16, the filters, the mutes. True when a stage has something to do. */
  begin(n: number): boolean {
    const held = this.kill ? 0 : ((this.held | this.latched | (this.solo ? ((~this.solo & 15) << PF_M1) >>> 0 : 0)) & this.avail()) >>> 0;
    const k = this.k;
    if (!held && !this.busy && !(k[0] | k[1] | k[2])) {
      this.ph = (this.ph + n) >>> 0;
      this.sync = false;
      return false;
    }
    this.P = this.beatSamples() >>> 2;
    if (this.sync) { this.ph = 0; this.sync = false; }
    const ph0 = this.ph % this.P;
    const bnd = ph0 ? (this.P - ph0 < n ? this.P - ph0 : n) : 0;
    this.ph = (this.ph + n) >>> 0;
    this.act = (this.act & held) >>> 0;
    this.act = (this.act | (held & ~PF_Q)) >>> 0;
    this.act0 = this.act;
    const q = (held & PF_Q & ~this.act) >>> 0;
    this.split = n;
    if (q && (!this.playing || bnd < n)) {
      this.split = this.playing ? bnd : 0;
      this.act = (this.act | q) >>> 0;
    }
    const m = k[0];
    {
      const bar = 16 * this.P;
      let lt = PF_TOP, ht = 0;
      this.lt = this.act & bit(PF_LPF) ? this.lt + n : 0;
      this.ht = this.act & bit(PF_HPF) ? this.ht + n : 0;
      const span = PF_TOP - PF_LOW;
      if (this.lt) {
        const t = this.lt < bar ? this.lt : bar;
        lt = PF_TOP - (Math.floor(span / 64) * Math.floor((t * 64) / bar));
      }
      if (m < 0 && PF_TOP + Math.trunc((m * span) / 100) < lt) lt = PF_TOP + Math.trunc((m * span) / 100);
      if (this.ht) {
        const t = this.ht < bar ? this.ht : bar;
        ht = Math.floor(span / 64) * Math.floor((t * 64) / bar);
      }
      if (m > 0 && Math.trunc((m * span) / 100) > ht) ht = Math.trunc((m * span) / 100);
      this.lc += clamp(lt - this.lc, -192, 192);
      this.hc += clamp(ht - this.hc, -192, 192);
      for (let c = 0; c < 3; c++) {
        const i = this.lc >> 8, f = this.lc & 255, j = this.hc >> 8, g = this.hc & 255;
        this.lk[c] = PF_SVF[i * 3 + c] + (((PF_SVF[(i < 63 ? i + 1 : 63) * 3 + c] - PF_SVF[i * 3 + c]) * f) >> 8);
        this.hk[c] = PF_SVF[j * 3 + c] + (((PF_SVF[(j < 63 ? j + 1 : 63) * 3 + c] - PF_SVF[j * 3 + c]) * g) >> 8);
      }
    }
    {
      const s = THR_SLOPE * n;
      this.rw = this.rw1;
      this.ew = this.ew1;
      this.rw1 += clamp((this.act & bit(PF_RTHR) ? 32768 : 0) - this.rw1, -s, s);
      this.ew1 += clamp((this.act & bit(PF_ETHR) ? 32768 : 0) - this.ew1, -s, s);
      this.thr = (this.rw | this.rw1 | this.ew | this.ew1) !== 0;
    }
    this.muteMask = 0;
    for (let t = 0; t < NTRK; t++) if (((held >>> (PF_M1 + t)) & 1) || this.mg[t] !== 32768) this.muteMask |= 1 << t;
    this.busy = true;
    return true;
  }

  /** A track muted by its key: its signal ramps to 0 and back. */
  mute(t: number, b: Int32Array, n: number): void {
    let g = this.mg[t];
    const target = (this.act >>> (PF_M1 + t)) & 1 ? 0 : 32768;
    for (let i = 0; i < n; i++) {
      g += clamp(target - g, -SL_SLOPE, SL_SLOPE);
      b[i] = mulq16(b[i], (g << 1) >>> 0);
    }
    this.mg[t] = g;
  }

  /** Before the buses: THROW (KNOB 3) adds the dry mix to the delay and reverb sends. */
  pre(ml: Int32Array, mr: Int32Array, sd: Int32Array, sr: Int32Array, n: number): void {
    const m = this.k[2] * 327;
    for (let i = 0; i < n; i++) {
      this.td += clamp(m - this.td, -SL_SLOPE, SL_SLOPE);
      if (this.td) {
        const x = mulq16((ml[i] + mr[i]) >> 1, (this.td << 1) >>> 0);
        sd[i] += x;
        sr[i] += x;
      }
    }
  }

  /** REV / ECHO THROW: a track's reverb / delay send towards full while held. */
  throwSend(level: number, rev: number, dly: number, b: Int32Array, sd: Int32Array, sr: Int32Array, n: number): void {
    const lvl = LEVEL_Q12[level & 127];
    const rg = 32766 - rev * 258, dg = 32766 - dly * 258;
    let rw = this.rw, ew = this.ew;
    const r1 = this.rw1, e1 = this.ew1;
    for (let i = 0; i < n; i++) {
      const x = clamp(Math.imul(b[i] >> 2, lvl) >> 10, -65536, 65536);
      rw += clamp(r1 - rw, -THR_SLOPE, THR_SLOPE);
      ew += clamp(e1 - ew, -THR_SLOPE, THR_SLOPE);
      sr[i] += mulq15(x, mulq16(rg, (rw << 1) >>> 0));
      sd[i] += mulq15(x, mulq16(dg, (ew << 1) >>> 0));
    }
  }

  // ---- the buffer ----
  private pbPut(f: number, l: number, r: number): void {
    const o = 2 * (f & (PB_FRAMES - 1));
    this.buf[o] = clamp(l, -32768, 32767);
    this.buf[o + 1] = clamp(r, -32768, 32767);
  }
  private out0 = 0; private out1 = 0;
  private pbAt(s: number, n: number): void {
    const f = s >>> 1 < n ? s >>> 1 : n - 1;
    const p = 2 * (f & (PB_FRAMES - 1));
    const q = s & 1 ? (f + 1 < n ? p + 2 : p) : f ? p - 2 : p;
    this.out0 = (3 * this.buf[p] + this.buf[q]) >> 1;
    this.out1 = (3 * this.buf[p + 1] + this.buf[q + 1]) >> 1;
  }
  private pbLoop(rp: number, len: number, rev: boolean, n: number): void {
    let e = (len - 1 - rp) >>> 0;
    this.pbAt(rev ? e : rp, n);
    if (rp < e) e = rp;
    if (e < SL_RAMP) {
      this.out0 = (this.out0 * e) >> SL_RAMP_LOG2;
      this.out1 = (this.out1 * e) >> SL_RAMP_LOG2;
    }
  }
  private pbRec(f: number, l: number, r: number): number {
    if (!this.odd) { this.hl = l; this.hr = r; this.odd = 1; return f; }
    this.odd = 0;
    this.pbPut(f, (this.hl + l) >> 2, (this.hr + r) >> 2);
    return f + 1;
  }
  private grain(g: number, acc: Int32Array): void {
    const p = this.gp[g], tri = p < PB_GRAIN / 2 ? p : PB_GRAIN - p;
    if (!p) this.gs[g] = Math.floor(((rng() >>> 16) * (this.wr - PB_GRAIN / 2 + 1)) / 65536);
    this.pbAt(2 * this.gs[g] + p, this.wr);
    acc[0] += this.out0 * tri;
    acc[1] += this.out1 * tri;
    this.gp[g] = p + 1 < PB_GRAIN ? p + 1 : 0;
  }
  private tapL = 0; private tapR = 0;
  private hbTap(ph: number): void {
    const d = ((HB_BASE << 16) + (ph >>> 5)) >>> 0, di = d >>> 16;
    const f = (d >>> 1) & 0x7fff;
    if (di + 1 > this.len) { this.tapL = this.tapR = 0; return; }
    const p = 2 * ((this.wr - di) & HB_MASK), q = 2 * ((this.wr - di - 1) & HB_MASK);
    this.tapL = this.buf[p] + (((this.buf[q] - this.buf[p]) * f) >> 15);
    this.tapR = this.buf[p + 1] + (((this.buf[q + 1] - this.buf[p + 1]) * f) >> 15);
  }
  private readonly ac = new Int32Array(2);
  private harm(l: number, r: number): void {
    const wa = (32768 - oscSine((this.hph + 0x40000000) >>> 0)) >> 1;
    this.hbTap(this.hph);
    const al = this.tapL, ar = this.tapR;
    this.hbTap((this.hph + 0x80000000) >>> 0);
    const bl = this.tapL, br = this.tapR;
    const sl = (al * wa + bl * (32768 - wa)) >> 15, sr = (ar * wa + br * (32768 - wa)) >> 15;
    l >>= 1;
    r >>= 1;
    let xl = l, xr = r;
    if (this.hfb) {
      xl += softclip(mulq15(sl, this.hfb));
      xr += softclip(mulq15(sr, this.hfb));
    }
    if (this.len < SL_RAMP) {
      xl = (xl * this.len) >> SL_RAMP_LOG2;
      xr = (xr * this.len) >> SL_RAMP_LOG2;
    }
    this.pbPut(this.wr & HB_MASK, xl, xr);
    this.wr = (this.wr + 1) >>> 0;
    if (this.len <= HB_MASK) this.len++;
    this.hph = (this.hph + this.hinc) >>> 0;
    this.ac[0] = l + (l >> 3) + ((sl * 45875) >> 15);
    this.ac[1] = r + (r >> 3) + ((sr * 45875) >> 15);
  }
  private bufDone(): void {
    if (this.next !== PF_N) this.bufStart(this.next);
    else this.mode = BM_NONE;
  }
  private rl = 0; private rr = 0;
  /** The buffer effect on one sample (the share w of what it plays, the rest live): result in rl / rr. */
  private bufSample(l: number, r: number): void {
    let yl = 0, yr = 0, on = 0;
    if (this.mode === BM_LOOP) {
      if (!this.state) {
        this.wr = this.pbRec(this.wr, l, r);
        if (++this.rp >= this.len) { this.state = 1; this.rp = 0; }
      } else {
        this.pbLoop(this.rp, this.len, this.rev, this.wr);
        yl = this.out0; yr = this.out1;
        if (this.xn) {
          const g = this.xn;
          this.pbLoop(this.xrp, this.xlen, this.xrev, this.wr);
          yl += (this.out0 * g) >> SL_RAMP_LOG2;
          yr += (this.out1 * g) >> SL_RAMP_LOG2;
          this.xn--;
          if (++this.xrp >= this.xlen) this.xrp = 0;
        }
        if (++this.rp >= this.len) this.rp = 0;
        on = 1;
      }
    } else if (this.mode === BM_TAPE) {
      this.wr = this.pbRec(this.wr, l, r);
      if (this.wr >= 2) {
        const f = this.tpos >>> 16;
        const fr = (this.tpos >>> 1) & 0x7fff;
        const p = 2 * (f & (PB_FRAMES - 1)), s = 2 * ((f + 1) & (PB_FRAMES - 1));
        let a = this.buf[p], b = this.buf[s];
        yl = (a + (((b - a) * fr) >> 15)) << 1;
        a = this.buf[p + 1]; b = this.buf[s + 1];
        yr = (a + (((b - a) * fr) >> 15)) << 1;
        const env = this.tv >= 8192 ? 32768 : (this.tv << 2) >>> 0;
        yl = mulq16(yl, (env << 1) >>> 0);
        yr = mulq16(yr, (env << 1) >>> 0);
        this.tpos = (this.tpos + (this.tv >>> 1)) >>> 0;
        this.tv = this.tv > this.dv ? this.tv - this.dv : 0;
        on = 1;
      }
    } else if (this.mode === BM_FRZ) {
      if (this.wr < PB_FREC) this.wr = this.pbRec(this.wr, l, r);
      if (this.wr >= PB_GRAIN / 2) {
        this.ac[0] = 0; this.ac[1] = 0;
        this.grain(0, this.ac);
        this.grain(1, this.ac);
        yl = this.ac[0] >> 10;
        yr = this.ac[1] >> 10;
        on = 1;
      }
    } else if (this.mode === BM_HARM) {
      this.harm(l, r);
      yl = this.ac[0]; yr = this.ac[1];
      on = 2;
    }
    this.tw = on && this.src !== PF_N ? (on === 2 ? 32768 : 32768 - this.k[3] * 327) : 0;
    this.w += clamp(this.tw - this.w, -SL_SLOPE, SL_SLOPE);
    if (this.w) {
      this.rl = pfMix(l, yl, this.w);
      this.rr = pfMix(r, yr, this.w);
    } else {
      this.rl = l; this.rr = r;
      if (this.src === PF_N) this.bufDone();
    }
  }

  private svf(x: number, z: Int32Array, o: number, c: Int16Array, hp: boolean): number {
    const v3 = x - z[o + 1], v1 = (c[0] * z[o] + c[1] * v3) >> 14, v2 = z[o + 1] + ((c[1] * z[o] + c[2] * v3) >> 14);
    z[o] = 2 * v1 - z[o];
    z[o + 1] = 2 * v2 - z[o + 1];
    return hp ? x - v1 - v2 : v2;
  }

  // ---- FLANGER, PHASER ----
  private lfoInc = 0;
  private lfoQ(s: number, n: number): number {
    const per = s * this.P;
    this.lfoInc = Math.floor(0xffffffff / per);
    return (((this.ph - n) >>> 0) % per) * this.lfoInc >>> 0;
  }
  private modDepth(): number { return (PF_HARM >>> this.pick(this.act)) & 1 ? 32768 : 32768 - this.k[3] * 327; }
  private flSide(c: number, x: number, q: number): number {
    const t = pfTri(q), d = ((FL_MIN << 16) + (FL_MAX - FL_MIN) * ((t * t) >>> 16)) >>> 0;
    let r0 = this.fwp - (d >>> 16);
    const fr = (d >>> 1) & 0x7fff;
    if (r0 < 0) r0 += FL_LEN;
    const r1 = r0 ? r0 - 1 : FL_LEN - 1;
    const a = this.flBuf[r0 * 2 + c];
    const v = a + (((this.flBuf[r1 * 2 + c] - a) * fr) >> 15);
    this.flBuf[this.fwp * 2 + c] = clamp((x >> 1) + softclip(mulq15(v, FL_FB)), -32767, 32767);
    return pfMix(x, mulq16((x >> 1) + v, 55706), this.fw);
  }
  private flanger(bl: Int32Array, br: Int32Array, n: number): void {
    let q = this.lfoQ(16, n);
    const inc = this.lfoInc;
    const tw = this.act & bit(PF_FLG) ? this.modDepth() : 0;
    if (!this.fw && !(this.act & bit(PF_FLG))) { this.fn = 0; return; }
    if (!this.fn) this.flBuf.fill(0);
    for (let i = 0; i < n; i++, q = (q + inc) >>> 0) {
      this.fw += clamp((this.fn > FL_MAX + 1 ? tw : 0) - this.fw, -SL_SLOPE, SL_SLOPE);
      bl[i] = this.flSide(0, bl[i], q);
      br[i] = this.flSide(1, br[i], (q - (1 << 30)) >>> 0);
      if (++this.fwp >= FL_LEN) this.fwp = 0;
      if (this.fn <= FL_MAX + 1) this.fn++;
    }
  }
  private phCoef(q: number): number {
    const t = pfTri(q), i = t >> 11;
    return PH_A[i] + (((PH_A[i + 1] - PH_A[i]) * (t & 2047)) >> 11);
  }
  private phSide(c: number, x: number, a: number): number {
    const xs = clamp((x + 2) >> 2, -16383, 16383);
    let u = xs + ((this.pfb[c] * PH_FB + 16384) >> 15), y = u;
    const o = c * PH_ST;
    for (let s = 0; s < PH_ST; s++) {
      y = clamp(this.px[o + s] + ((a * (u - this.py[o + s]) + 8192) >> 14), -65535, 65535);
      this.px[o + s] = u;
      this.py[o + s] = y;
      u = y;
    }
    this.pfb[c] = clamp(y, -32767, 32767);
    u = xs + y;
    return pfMix(x, u + mulq16(u, 52429), this.pw);
  }
  private phaser(bl: Int32Array, br: Int32Array, n: number): void {
    const base = this.lfoQ(8, n);
    const inc = this.lfoInc;
    const q = (base + (n >> 1) * inc) >>> 0;
    const tw = this.act & bit(PF_PHS) ? this.modDepth() : 0;
    const a0 = this.phCoef(q), a1 = this.phCoef((q - 0x40000000) >>> 0);
    if (!this.pw) { this.px.fill(0); this.py.fill(0); this.pfb[0] = this.pfb[1] = 0; }
    for (let i = 0; i < n; i++) {
      this.pw += clamp(tw - this.pw, -SL_SLOPE, SL_SLOPE);
      bl[i] = this.phSide(0, bl[i], a0);
      br[i] = this.phSide(1, br[i], a1);
    }
  }

  /** After the master level: the buffer effect, LPF, HPF, CRUSH, FLANGER, PHASER on l / r (stereo, Q15). Call only when begin() was true. */
  block(bl: Int32Array, br: Int32Array, n: number): void {
    let a = this.act0;
    const k = this.k;
    const c = k[1];
    if (c) this.cc = c;
    const ct = c ? 32768 : 0;
    const sh = 4 + Math.floor((this.cc * 7) / 100);
    const hold = sh - 3;
    if (this.split) this.bufSelect(this.pick(a));
    this.hfb += clamp(k[3] * HB_FB - this.hfb, -512, 512);
    for (let i = 0; i < n; i++) {
      let l = bl[i], r = br[i];
      if (i === this.split) { a = this.act; this.bufSelect(this.pick(a)); }
      if (this.mode !== BM_NONE) { this.bufSample(l, r); l = this.rl; r = this.rr; }
      const lt = a & bit(PF_LPF) || k[0] < 0 || this.lc < PF_TOP ? 32768 : 0;
      this.la += clamp(lt - this.la, -SL_SLOPE, SL_SLOPE);
      if (this.la) {
        const fl = this.svf(clamp(l >> 2, -32767, 32767), this.lz, 0, this.lk, false) << 2;
        const fr = this.svf(clamp(r >> 2, -32767, 32767), this.lz, 2, this.lk, false) << 2;
        l = pfMix(l, fl, this.la);
        r = pfMix(r, fr, this.la);
      } else this.lz.fill(0);
      const ht = a & bit(PF_HPF) || k[0] > 0 || this.hc > 0 ? 32768 : 0;
      this.ha += clamp(ht - this.ha, -SL_SLOPE, SL_SLOPE);
      if (this.ha) {
        const fl = this.svf(clamp(l >> 2, -32767, 32767), this.hz, 0, this.hk, true) << 2;
        const fr = this.svf(clamp(r >> 2, -32767, 32767), this.hz, 2, this.hk, true) << 2;
        l = pfMix(l, fl, this.ha);
        r = pfMix(r, fr, this.ha);
      } else this.hz.fill(0);
      this.cw += clamp(ct - this.cw, -SL_SLOPE, SL_SLOPE);
      if (this.cw) {
        if (++this.cn >= hold) {
          this.cn = 0;
          this.chl = ((l >> sh) << sh) + (1 << (sh - 1));
          this.chr = ((r >> sh) << sh) + (1 << (sh - 1));
        }
        l = pfMix(l, this.chl, this.cw);
        r = pfMix(r, this.chr, this.cw);
      }
      bl[i] = l;
      br[i] = r;
    }
    if (this.act & bit(PF_FLG) || this.fw || this.fn) this.flanger(bl, br, n);
    if (this.act & bit(PF_PHS) || this.pw) this.phaser(bl, br, n);
    this.busy = !!(this.act || this.mode !== BM_NONE || this.w || this.la || this.ha || this.cw || this.td || this.muteMask || this.fw ||
      this.pw || this.thr || this.fn || k[0] || k[1] || k[2]);
  }
}
