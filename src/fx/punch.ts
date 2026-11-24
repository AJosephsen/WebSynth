// PUNCH-IN FX, pocket-operator style (Melodee punch.c, GPL-3.0-only): 27 master effects for the whole mix while an effect is held.
// SLOOP punch DSP by isod89 (isod89/sloop-fm1, commit 4ec1ac8), adapted by Kerem Kilic (Ellic Studio); the SVF equations and the
// reverb input diffuser are Felucca's (Leo Kuroshita, Hügelton Instruments). See NOTICE and docs of Melodee (SLOOP_PUNCH_FX.md).
// A mono 16384-sample history of the mix feeds the loops, reverse, tape stop, half speed, wobble, echo, rewind, octave up and the
// flanger; the filters, kills, crush and gate run in stereo; FREEZE holds a four-line reverb that lives in the same memory.
// Runs after the master level and before the limiter, in blocks of up to CTL samples. Every change crossfades over 64 samples.
import { clamp, sineI, softclip, Tsvf, tsvfLp } from "../engines/dsp";
import { CTL, FS } from "../engines/types";

export const PUNCH_N = 16384;
export const PUNCH_NFX = 27;
export const PX_LOOP4 = 0, PX_LOOP8 = 1, PX_LOOP16 = 2, PX_LOOP32 = 3, PX_STUT = 4, PX_REV = 5, PX_STOP = 6, PX_HALF = 7,
  PX_LPF = 8, PX_HPF = 9, PX_TEL = 10, PX_CRUSH = 11, PX_DOWN = 12, PX_GATE = 13, PX_ECHO = 14, PX_WOBBLE = 15,
  PX_KLOW = 16, PX_KMID = 17, PX_KHIGH = 18, PX_RWD = 19, PX_OCT = 20, PX_FLANGE = 21, PX_PAN = 22, PX_FREEZE = 23,
  PX_LOOP8T = 24, PX_MONO = 25, PX_FADE = 26;
export const PUNCH_NAME = [
  "LOOP 1/4", "LOOP 1/8", "LOOP 1/16", "LOOP 1/32", "STUTTER", "REVERSE", "STOP", "HALF",
  "LOW PASS", "HIGH PASS", "PHONE", "CRUSH", "ALIAS", "GATE", "ECHO", "WOBBLE",
  "KILL LOW", "KILL MID", "KILL HIGH", "REWIND", "OCT UP", "FLANGER", "AUTO-PAN", "FREEZE", "LOOP 1/8T", "MONO", "FADE OUT",
];

const PX_OCT_W = 2048;
const PX_FRZ_CAP = 8192;
const PX_RWD_ACC = 17;
const PX_RWD_MAX = 3 << 16;
const MASK = PUNCH_N - 1;
const DIV = [1, 2, 4, 8, 6, 1, 1, 2];
const U32 = 0xffffffff;
// FREEZE's reverb (fx_sloop_reverb.h): line lengths and bases, the two input all-passes, and the state's layout in the history
const SR_LEN = [1573, 1931, 2389, 2791];
const SR_BASE = [0, 1573, 3504, 5893];
const SR_AP = [556, 441];
const SR_AP_AT = 8684; // the all-pass memory follows the lines (int16 index)
const SR_POS_AT = 19362, SR_APPOS_AT = 19370, SR_LOW_AT = 19376; // byte offsets of pos[4], ap_pos[2], low[4]

const pxLoop = (fx: number): boolean => fx <= PX_STUT || fx === PX_LOOP8T;
const pxReplay = (fx: number): boolean => fx <= PX_HALF || fx === PX_LOOP8T;
const divPow2 = (x: number, shift: number): number => (x + (((x >>> 31) * ((1 << shift) - 1)) | 0)) >> shift;
export const punchNeedsRing = (fx: number): boolean =>
  fx >= 0 && (fx <= PX_HALF || fx === PX_ECHO || fx === PX_WOBBLE || fx === PX_RWD || fx === PX_OCT || fx === PX_FLANGE || fx === PX_FREEZE || fx === PX_LOOP8T);

/** The key of an effect (0..26 from F3) and back: the 16 white keys, then the 11 black ones. */
export function punchKey(k: number): number {
  const W = [0, -1, 1, -1, 2, -1, 3, 4, -1, 5, -1, 6];
  const i = W[k % 12];
  return i < 0 ? -1 : Math.floor(k / 12) * 7 + i;
}
const PUNCH_BLACK = [1, 3, 5, 8, 10, 13, 15, 17, 20, 22, 25];
export function punchFxOfKey(k: number): number {
  const w = punchKey(k);
  if (w >= 0) return w;
  const i = PUNCH_BLACK.indexOf(k);
  return i < 0 ? -1 : 16 + i;
}
export function punchKeyOfFx(fx: number): number {
  const K = [0, 2, 4, 6, 7, 9, 11];
  fx %= PUNCH_NFX;
  return fx < 16 ? Math.floor(fx / 7) * 12 + K[fx % 7] : PUNCH_BLACK[fx - 16];
}

let klo: Tsvf | null = null, khi: Tsvf | null = null;

/** The punch layer and its state. */
export class Punch {
  // ---- what the host sets (the keys, the song and the transport) ----
  /** The effect asked for by the keys (-1 none). */
  req = -1;
  /** A key is down: arms the layer and gives it its history. */
  keyHeld = false;
  /** The song's request (-1 none), whether it needs the history, and the counter that restarts an unchanged one. */
  songReq = -1;
  songBuffered = false;
  songGate = 0;
  /** Samples in a quarter note, the transport phase in samples (within the quarter) and whether the song plays. */
  beat = Math.floor((FS * 60) / 120);
  clock = 0;
  playing = false;

  // ---- state ----
  private ring: Int16Array | null = null;
  private buf: ArrayBuffer | null = null;
  private allocTried = false;
  cur = -1;
  g = 0;
  private songGateSeen = 0;
  private wasFreeze = false;
  private w = 0; private start = 0; private t = 0; private len = 0; private pre = 0; private k = 0; private sub = 0;
  private dspd = 0; private gp = 0; private rp = 0; private spd = 0; private lfo = 0;
  private heldL = 0; private heldR = 0; private hn = 0;
  private readonly f = new Int32Array(8); // the filters' states: f1l f2l f1r f2r f3l f4l f3r f4r
  private cut = 0;
  private readonly z = new Int32Array(16); // the kills' SVF states: left 0..3, right 4..7, two each
  private v = 0; private fv = 0;
  private readonly kl = new Int32Array(CTL);
  private readonly kr = new Int32Array(CTL);
  private readonly c1 = new Tsvf();
  private readonly c2 = new Tsvf();
  // FREEZE's tank, inside the history
  private lineP: Uint16Array | null = null; private apP: Uint16Array | null = null; private low: Int32Array | null = null;

  /** The effect is held (-1 releases it): a key, as the pad or the FX keys give it. */
  hold(fx: number): void {
    this.req = fx >= 0 && fx < PUNCH_NFX ? fx : -1;
    this.keyHeld = this.req >= 0;
  }

  /** Everything off and the history released (a project change, the FX epoch). */
  reset(): void {
    this.req = -1; this.keyHeld = false;
    this.cur = -1; this.g = 0; this.songGateSeen = 0; this.wasFreeze = false;
    this.w = 0; this.start = 0; this.t = 0; this.len = 0; this.pre = 0; this.k = 0; this.sub = 0;
    this.dspd = 0; this.gp = 0; this.rp = 0; this.spd = 0; this.lfo = 0;
    this.heldL = 0; this.heldR = 0; this.hn = 0; this.f.fill(0); this.cut = 0; this.z.fill(0); this.v = 0; this.fv = 0;
    this.release();
  }

  /** True while the layer is doing anything (or can start at once): the host skips the call otherwise. */
  get active(): boolean {
    return this.keyHeld || this.songBuffered || this.songReq >= 0 || this.cur >= 0 || this.req >= 0 || this.ring !== null;
  }

  private release(): void {
    this.ring = null; this.buf = null; this.allocTried = false;
    this.lineP = this.apP = null; this.low = null;
  }

  private alloc(): void {
    if (this.ring || this.allocTried) return;
    this.allocTried = true;
    this.buf = new ArrayBuffer(PUNCH_N * 2);
    this.ring = new Int16Array(this.buf);
    this.lineP = new Uint16Array(this.buf, SR_POS_AT, 4);
    this.apP = new Uint16Array(this.buf, SR_APPOS_AT, 2);
    this.low = new Int32Array(this.buf, SR_LOW_AT, 4);
  }

  private raw(i: number): number { return this.ring![i & MASK]; }
  private rawQ16(p: number): number {
    const a = this.raw(p >>> 16), b = this.raw((p >>> 16) + 1);
    return a + (Math.imul(b - a, (p >>> 1) & 0x7fff) >> 15);
  }
  private q16(p: number): number { return this.rawQ16(p) * 8; }

  private begin(fx: number): void {
    const beat = this.beat, ph = this.clock;
    this.cur = fx;
    if (fx === PX_FREEZE || this.wasFreeze) this.ring!.fill(0);
    this.wasFreeze = fx === PX_FREEZE;
    this.t = 0;
    let len = fx <= PX_HALF ? Math.floor(beat / DIV[fx]) : fx === PX_LOOP8T ? Math.floor(beat / 3) : beat;
    if (len > PUNCH_N - 1024) len = PUNCH_N - 1024;
    if (len < 64) len = 64;
    this.len = len;
    this.pre = 0;
    this.start = this.w;
    if (pxLoop(fx) && this.playing) { // on the grid
      const back = ph % len;
      if (len - back <= 1536) this.pre = len - back;
      else { this.start = (this.w - back) >>> 0; this.t = back; }
    }
    this.rp = (this.w << 16) >>> 0;
    this.spd = 65536;
    this.dspd = Math.floor(65536 / len) + 1;
    this.sub = 0;
    this.k = this.t % len;
    this.lfo = 0;
    this.hn = 0;
    this.cut = 127 << 8;
    this.f.fill(0);
    this.z.fill(0);
    this.v = 65536;
    this.fv = (32767 << 8) >>> 0;
    if (fx === PX_PAN && this.playing) this.lfo = Math.imul(ph, Math.floor(U32 / beat)) >>> 0;
    if (fx === PX_FLANGE) this.lfo = 0xc0000000;
  }

  /** The wet sample of the mono ring effects (the ring has this sample already). */
  private ringFx(fx: number): number {
    const len = this.len, k = this.k;
    let y: number;
    if (fx === PX_REV) y = this.raw(this.start - k) * 8;
    else if (fx === PX_STOP) {
      y = this.q16(this.rp);
      this.rp = (this.rp + this.spd) >>> 0;
      this.spd = this.spd > this.dspd ? this.spd - this.dspd : 0;
      return Math.imul(y >> 3, this.spd >>> 4) >> 9;
    } else if (fx === PX_WOBBLE) {
      const d = 700 + (Math.imul(sineI(this.lfo), 180) >> 15);
      this.lfo = (this.lfo + 4 * Math.floor(U32 / FS)) >>> 0;
      return this.q16(((this.w << 16) - (d << 16)) >>> 0);
    } else y = this.raw(this.start + k) * 8;
    if (fx !== PX_HALF || (this.sub ^= 1) === 0) this.k = k + 1 >= len ? 0 : k + 1;
    return k < 64 ? Math.imul(y, k) >> 6 : len - k < 64 ? Math.imul(y, len - k) >> 6 : y;
  }

  /** The loops, STUTTER, HALF and REVERSE replay ring samples; the writer skips the span once it is captured. */
  private owns(fx: number, w: number): boolean {
    const d = (w - this.start) >>> 0, len = this.len;
    if (fx < 0 || !pxReplay(fx) || fx === PX_STOP || this.pre) return false;
    if (fx === PX_REV) return d >= 1 && ((d + len - 1) & MASK) < len;
    return d >= len && (d & MASK) < len;
  }

  /** One kill on a channel for the block: two SVFs (Linkwitz-Riley) per band; z0 is the channel's first state slot. */
  private killRun(fx: number, lo: Tsvf, hi: Tsvf, inp: Int32Array, out: Int32Array, n: number, z0: number): void {
    const z = this.z;
    const a1 = lo.a1, a2 = lo.a2, a3 = lo.a3, b1 = hi.a1, b2 = hi.a2, b3 = hi.a3;
    let z00 = z[z0], z01 = z[z0 + 1], z10 = z[z0 + 2], z11 = z[z0 + 3], z20 = z[z0 + 4], z21 = z[z0 + 5], z30 = z[z0 + 6], z31 = z[z0 + 7];
    let v1 = 0, v2 = 0, h = 0, t = 0, x = 0, a = 0, b = 0;
    // one SVF step; sets v1, v2 (for the high-pass) and returns the low-pass; the states come back through zz
    const step = (A1: number, A2: number, A3: number, Z0: number, Z1: number, IN: number, zz: Int32Array): number => {
      const v3 = (IN - Z1) | 0;
      v1 = (Math.imul(A1, Z0) + Math.imul(A2, v3)) >> 13;
      v2 = (Z1 + ((Math.imul(A2, Z0) + Math.imul(A3, v3)) >> 13)) | 0;
      zz[0] = clamp(2 * v1 - Z0, -150000, 150000);
      zz[1] = clamp(2 * v2 - Z1, -150000, 150000);
      return v2;
    };
    const hp = (IN: number): number => (IN - (Math.imul(v1, 5799) >> 12) - v2) | 0;
    const s = this.sv;
    if (fx === PX_KLOW) {
      for (let i = 0; i < n; i++) {
        x = clamp(inp[i], -131071, 131071) >> 1;
        step(a1, a2, a3, z00, z01, x, s); h = hp(x); z00 = s[0]; z01 = s[1];
        step(a1, a2, a3, z10, z11, h, s); b = hp(h); z10 = s[0]; z11 = s[1];
        out[i] = b * 2;
      }
    } else if (fx === PX_KHIGH) {
      for (let i = 0; i < n; i++) {
        x = clamp(inp[i], -131071, 131071) >> 1;
        t = step(b1, b2, b3, z00, z01, x, s); z00 = s[0]; z01 = s[1];
        a = step(b1, b2, b3, z10, z11, t, s); z10 = s[0]; z11 = s[1];
        out[i] = a * 2;
      }
    } else {
      for (let i = 0; i < n; i++) {
        x = clamp(inp[i], -131071, 131071) >> 1;
        t = step(a1, a2, a3, z00, z01, x, s); z00 = s[0]; z01 = s[1];
        a = step(a1, a2, a3, z10, z11, t, s); z10 = s[0]; z11 = s[1];
        step(b1, b2, b3, z20, z21, x, s); h = hp(x); z20 = s[0]; z21 = s[1];
        step(b1, b2, b3, z30, z31, h, s); b = hp(h); z30 = s[0]; z31 = s[1];
        out[i] = ((a + b) | 0) * 2;
      }
    }
    z[z0] = z00; z[z0 + 1] = z01; z[z0 + 2] = z10; z[z0 + 3] = z11; z[z0 + 4] = z20; z[z0 + 5] = z21; z[z0 + 6] = z30; z[z0 + 7] = z31;
  }
  private readonly sv = new Int32Array(2);

  /** FREEZE: the mix goes through SLOOP's reverb in capture mode (input for the first 8192 samples), then it only holds. */
  private freezeBlock(l: Int32Array, r: Int32Array, n: number): void {
    const wl = this.kl, wr = this.kr;
    for (let i = 0; i < n; i++) { wl[i] = l[i]; wr[i] = r[i]; }
    let feed = this.t < PX_FRZ_CAP ? PX_FRZ_CAP - this.t : 0;
    if (feed > n) feed = n;
    if (feed) this.reverb(feed, wl, wr, 0, 1);
    if (feed < n) this.reverb(n - feed, wl, wr, feed, 2);
  }

  /** fx_sloop_reverb_run_mode in its capture modes (1: feed, 2: hold): fixed taps, unity feedback, no damping, wet only. */
  private reverb(n: number, wl: Int32Array, wr: Int32Array, o: number, capture: number): void {
    const line = this.ring!, ap = this.ring!, pos = this.lineP!, apPos = this.apP!, low = this.low!;
    for (let i = 0; i < n; i++) {
      const dl = wl[o + i], dr = wr[o + i];
      const mono = divPow2(clamp(dl, -1048575, 1048575) + clamp(dr, -1048575, 1048575), 1);
      const input = capture === 2 ? 0 : mono; // the wet-input tone is off in this state: the input passes unchanged
      let a = divPow2(clamp(input, -262143, 262143), 4);
      a = divPow2(Math.imul(a, 13000), 15);
      let off = SR_AP_AT;
      for (let k = 0; k < 2; k++) {
        const b = ap[off + apPos[k]], v = a + (b >> 1);
        ap[off + apPos[k]] = clamp(v, -32768, 32767);
        a = b - (v >> 1);
        if (++apPos[k] === SR_AP[k]) apPos[k] = 0;
        off += SR_AP[k];
      }
      let tap = pos[0];
      if (tap >= SR_LEN[0]) tap -= SR_LEN[0];
      const next = tap + 1 === SR_LEN[0] ? 0 : tap + 1;
      let o0 = line[tap];
      o0 += (Math.imul(line[next] - o0, 0) + 128) >> 8;
      const o1 = line[SR_BASE[1] + pos[1]], o2 = line[SR_BASE[2] + pos[2]], o3 = line[SR_BASE[3] + pos[3]];
      const s0 = o0 + o1, s1 = o2 + o3, d0 = o0 - o1, d1 = o2 - o3;
      const v4 = [s0 + s1, d0 + d1, s0 - s1, d0 - d1];
      for (let k = 0; k < 4; k++) {
        const fb = divPow2(v4[k], 1);
        low[k] = fb;
        line[SR_BASE[k] + pos[k]] = clamp(fb + ((k & 1) ? -a : a), -32768, 32767);
        if (++pos[k] === SR_LEN[k]) pos[k] = 0;
      }
      const ol = (o0 + o2) * 8, or = (o1 - o3) * 8;
      wl[o + i] = clamp(ol, -262143, 262143); // mix 1.0 into a wet-only return: the dry term cancels
      wr[o + i] = clamp(or, -262143, 262143);
    }
  }

  /** l, r: the mix before the limiter, n <= CTL samples, in place. */
  process(l: Int32Array, r: Int32Array, n: number): void {
    if (!n) return;
    const armed = this.keyHeld || this.songBuffered || this.songReq >= 0;
    if (!armed && this.cur < 0 && this.req < 0) {
      if (this.ring || this.allocTried) this.release();
      return;
    }
    if (this.songBuffered || this.keyHeld) this.alloc();
    let want = this.req >= 0 ? this.req : this.songReq;
    if (want < -1 || want >= PUNCH_NFX) want = -1;
    if (punchNeedsRing(want) && !this.ring) want = -1;
    if (this.cur < 0 && want < 0) { // idle: only the ring
      if (this.ring && !this.wasFreeze) for (let i = 0; i < n; i++) this.ring[this.w++ & MASK] = clamp((l[i] + r[i]) >> 4, -32768, 32767), this.w >>>= 0;
      return;
    }
    if (this.cur < 0 && want >= 0) { this.begin(want); this.songGateSeen = this.songGate; }
    const restart = this.req < 0 && this.songGateSeen !== this.songGate;
    if (this.cur === PX_FREEZE) this.freezeBlock(l, r, n);
    const beat = this.beat;
    const step = Math.floor(beat / 4) ? Math.floor(beat / 4) : 1;
    let echoD = Math.floor((beat * 3) / 4);
    if (echoD > PUNCH_N - 64) echoD = PUNCH_N - 64;
    const binc = Math.floor(U32 / beat);
    const fdec = Math.floor((32767 << 8) / (2 * beat));
    if (this.cur === PX_GATE) this.gp = (this.playing ? this.clock : this.t) % step;
    const fx = this.cur;
    const c1 = this.c1, c2 = this.c2;
    if (fx === PX_LPF && this.g > 0) this.cut = this.cut > (34 << 8) ? this.cut - 96 : 34 << 8; // closes over ~1 s
    if (fx === PX_HPF && this.g > 0) this.cut = this.cut > (88 << 8) ? this.cut - 64 : 88 << 8;
    if (fx >= PX_KLOW && fx <= PX_KHIGH) {
      if (!klo || !khi) { klo = new Tsvf(); khi = new Tsvf(); klo.setK(43 << 8, 5799); khi.setK(89 << 8, 5799); } // 251 Hz, 2.44 kHz
      if (n <= CTL) {
        this.killRun(fx, klo, khi, l, this.kl, n, 0);
        this.killRun(fx, klo, khi, r, this.kr, n, 8);
      }
    } else if (fx === PX_LPF || fx === PX_HPF || fx === PX_TEL) {
      c1.setK(fx === PX_LPF ? this.cut : fx === PX_HPF ? (127 << 8) - this.cut + (40 << 8) : 96 << 8, 2807);
      c2.setK(58 << 8, 5799);
    }
    const f = this.f, kl = this.kl, kr = this.kr;
    const target = (fx >= 0 && want === fx && !restart) ? 32767 : 0;
    for (let i = 0; i < n; i++) {
      const dryL = l[i], dryR = r[i];
      const x = clamp(dryL, -131071, 131071), y = clamp(dryR, -131071, 131071);
      let wl = x, wr = y;
      const m = (x + y) >> 1;
      if (this.ring && !this.wasFreeze && !this.owns(fx, this.w)) this.ring[this.w & MASK] = clamp(m >> 3, -32768, 32767);
      switch (fx) {
        case PX_LPF:
          wl = tsvfLp(c1, x >> 1, f, 0) * 2;
          wr = tsvfLp(c1, y >> 1, f, 2) * 2;
          break;
        case PX_HPF:
          wl = x - tsvfLp(c1, x >> 1, f, 0) * 2;
          wr = y - tsvfLp(c1, y >> 1, f, 2) * 2;
          break;
        case PX_TEL: {
          let b = tsvfLp(c1, m >> 1, f, 0); // < 2.5 kHz
          b -= tsvfLp(c2, b, f, 4); // > 500 Hz
          wl = wr = softclip(b * 4) >> 1;
          break;
        }
        case PX_CRUSH:
          wl = x >= 0 ? x & ~0x7ff : -(-x & ~0x7ff);
          wr = y >= 0 ? y & ~0x7ff : -(-y & ~0x7ff);
          break;
        case PX_DOWN:
          if (--this.hn <= 0) { this.hn = 8; this.heldL = x; this.heldR = y; }
          wl = this.heldL; wr = this.heldR;
          break;
        case PX_GATE: {
          const p = this.gp, half = step >>> 1;
          let gg = p < half ? 32767 : 0;
          this.gp = p + 1 >= step ? 0 : p + 1;
          if (p < 64) gg = p * 512;
          else if (p >= half && p < half + 64) gg = 32767 - (p - half) * 512;
          wl = Math.imul(x >> 3, gg) >> 12;
          wr = Math.imul(y >> 3, gg) >> 12;
          break;
        }
        case PX_KLOW: case PX_KMID: case PX_KHIGH:
          wl = kl[i & (CTL - 1)];
          wr = kr[i & (CTL - 1)];
          break;
        case PX_RWD: { // the record pulled back: slows, stops, spins backwards
          const back = (this.w - (this.rp >>> 16)) & 0xffff;
          const room = PUNCH_N - 512 - back;
          if (room <= 0) { wl = wr = 0; break; } // all of it heard: silence until the key is up
          const e = room < 1024 ? room * 32 : 32767;
          wl = wr = (Math.imul(this.rawQ16(this.rp), e) >> 15) * 8;
          this.rp = (this.rp + this.v) >>> 0;
          if (this.v > -PX_RWD_MAX) this.v -= PX_RWD_ACC;
          break;
        }
        case PX_OCT: { // two taps read at twice the speed, half a window apart
          const d1 = PX_OCT_W - this.k, d2 = d1 > PX_OCT_W / 2 ? d1 - PX_OCT_W / 2 : d1 + PX_OCT_W / 2;
          const g1 = (d1 <= PX_OCT_W / 2 ? d1 : PX_OCT_W - d1) << 5;
          const g2 = 32768 - g1;
          this.k = this.k + 1 >= PX_OCT_W ? 0 : this.k + 1;
          wl = wr = (Math.imul(this.raw(this.w - d1), g1) + Math.imul(this.raw(this.w - d2), g2)) >> 12;
          break;
        }
        case PX_FLANGE: { // 0.6..6 ms, swept over a bar, left and right a quarter apart
          const dl = ((26 << 16) + (sineI(this.lfo) + 32768) * 240) >>> 0;
          const dr = ((26 << 16) + (sineI((this.lfo + 0x40000000) >>> 0) + 32768) * 240) >>> 0;
          const pw = (this.w << 16) >>> 0;
          const el = this.rawQ16((pw - dl) >>> 0), er = this.rawQ16((pw - dr) >>> 0);
          this.lfo = (this.lfo + (binc >>> 2)) >>> 0;
          this.ring![this.w & MASK] = clamp((m >> 3) + (Math.imul(el + er, 9000) >> 15), -32768, 32767); // feedback
          wl = Math.imul(x + el * 8, 5) >> 3;
          wr = Math.imul(y + er * 8, 5) >> 3;
          break;
        }
        case PX_PAN: { // the mix in mono, left to right and back once a beat
          const a = ((((Math.imul(sineI(this.lfo), 28000) >> 15) + 32768)) << 14) >>> 0;
          const gl = Math.imul(sineI((a + 0x40000000) >>> 0), 46341) >> 15, gr = Math.imul(sineI(a), 46341) >> 15;
          this.lfo = (this.lfo + binc) >>> 0;
          wl = Math.imul(m >> 4, gl) >> 11;
          wr = Math.imul(m >> 4, gr) >> 11;
          break;
        }
        case PX_FREEZE: {
          const c = this.t < PX_FRZ_CAP ? this.t * 4 : 32767;
          wl = x + (Math.imul((kl[i] - x) >> 3, c >> 3) >> 9);
          wr = y + (Math.imul((kr[i] - y) >> 3, c >> 3) >> 9);
          break;
        }
        case PX_MONO:
          wl = wr = m;
          break;
        case PX_FADE: {
          const v = this.fv >>> 8, gq = (v * v) >> 15; // squared: the ear hears it even
          this.fv = this.fv > fdec ? this.fv - fdec : 0;
          wl = Math.imul(x >> 3, gq) >> 12;
          wr = Math.imul(y >> 3, gq) >> 12;
          break;
        }
        case PX_ECHO: {
          const e = Math.imul(this.raw(this.w - echoD), 18000) >> 12;
          this.ring![this.w & MASK] = clamp((m + e) >> 3, -32768, 32767); // feedback
          wl = x + e; wr = y + e;
          break;
        }
        default:
          if (fx < 0) break;
          if (this.pre) { // waiting for the division
            if (!--this.pre) { this.start = (this.w + 1) >>> 0; this.k = 0; }
            break;
          }
          wl = wr = this.ringFx(fx);
          break;
      }
      if (this.g < target) this.g = this.g + 512 > 32767 ? 32767 : this.g + 512;
      else if (this.g > target) this.g = this.g < 512 ? 0 : this.g - 512;
      l[i] = (dryL + (Math.imul((wl - dryL) >> 3, this.g >> 3) >> 9)) | 0;
      r[i] = (dryR + (Math.imul((wr - dryR) >> 3, this.g >> 3) >> 9)) | 0;
      this.w = (this.w + 1) >>> 0;
      this.t = (this.t + 1) >>> 0;
    }
    if (!this.g && (want !== this.cur || restart)) {
      this.cur = -1;
      if (this.wasFreeze) { this.ring!.fill(0); this.wasFreeze = false; }
    }
  }
}
