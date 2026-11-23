// SLICER: a per-track insert, a tempo-synced 16-step gate / stutter (Felucca's slicer.c, GPL-3.0-only). It works on the
// track's mono signal after DIST and the insert, before LEVEL / PAN and the sends. GATE closes the '.' steps (DEPTH: how far);
// STUT repeats the last live step in the '.' steps, cross-faded with the live sound. See NOTICE.
import { clamp, mulq16 } from "../engines/dsp";
import { FS } from "../engines/types";

export const SL_OFF = 0, SL_GATE = 1, SL_STUT = 2;
export const SLICER_MODES = ["OFF", "GATE", "STUT"];
export const SLICER_RATES = ["1/8", "1/16", "1/32", "8T", "16T", "32T"];
const SL_NPAT = 16, SL_LEN = 4096, SL_RAMP_LOG2 = 7, SL_RAMP = 128, SL_SLOPE = 32768 / SL_RAMP;
/** bit k = step k: 1 = 'x' (open / live), 0 = '.' (closed / repeat). */
export const SL_PAT = [0x5555, 0xb6db, 0x5249, 0xb777, 0x6d6d, 0x0f0f, 0x1111, 0x54a5, 0x5333, 0xa929, 0xaaff, 0xd501, 0xaaaa, 0xab6b, 0xbb5d, 0x7597];
const SL_DEN = [2, 4, 8, 3, 6, 12];

export interface SlicerSetting {
  /** 0 OFF, 1 GATE, 2 STUT. */
  mode: number;
  /** Pattern 1..16. */
  pat: number;
  /** The step: 1/8, 1/16, 1/32, 8T, 16T, 32T. */
  rate: number;
  /** GATE: how far a '.' step closes (127 = silent); STUT: the level of the repeat. */
  depth: number;
}
export const defaultSlicer = (): SlicerSetting => ({ mode: 0, pat: 1, rate: 1, depth: 100 });

export class Slicer {
  private pos = 0; private len = 0; private base = 0;
  private rp = 0; private loop = 0; private rec = 0;
  private gc = 0; private w = 0; private half = 0;
  private idx = 15; private bit = 0; private recOn = false;
  private readonly buf = new Int16Array(SL_LEN);

  /** The transport starts: step 0 begins with the sequencer's. */
  start(): void { this.idx = 15; this.pos = this.len = 0; }

  /** A repeat is playing or fading (the track must still be rendered). */
  get busy(): boolean { return !!(this.w || this.loop); }

  private pattern(s: SlicerSetting): number { return SL_PAT[(((s.pat - 1) % SL_NPAT) + SL_NPAT) % SL_NPAT]; }

  private enter(s: SlicerSetting, bpm: number, trackSwing: number): void {
    this.idx = (this.idx + 1) & 15;
    this.base = Math.floor(Math.floor((FS * 60) / bpm) / SL_DEN[s.rate % 6]);
    const sw = Math.trunc((trackSwing * this.base) / 250);
    this.len = this.base + (this.idx & 1 ? -sw : sw);
    this.pos = 0;
    this.bit = (this.pattern(s) >> this.idx) & 1;
    this.rp = 0;
    this.loop = 0;
    this.recOn = false;
    if (s.mode !== SL_STUT) {
      this.rec = 0;
    } else if (this.bit) {
      this.rec = 0;
      this.recOn = true;
    } else if (this.rec >= 2 * SL_RAMP) {
      let l = this.base;
      while (l > 2 * SL_LEN) l >>= 1;
      this.loop = l < 2 * this.rec ? l : 2 * this.rec;
    }
  }

  /** m samples of one step (no boundary inside); sd: SPREAD's side signal. */
  private seg(s: SlicerSetting, b: Int32Array, o: number, sd: Int32Array | undefined, m: number): void {
    const mode = s.mode, nbit = (this.pattern(s) >> ((this.idx + 1) & 15)) & 1;
    const depth = s.depth * 258;
    const tc = mode === SL_GATE && !this.bit ? depth : 0;
    const tn = mode === SL_GATE && !nbit ? depth : 0;
    const tw = mode === SL_STUT && this.loop ? depth : 0;
    for (let j = 0; j < m; j++) {
      const x = b[o + j];
      let tg = tc;
      const left = this.len - this.pos - j;
      if (left <= SL_RAMP && tn > tg) tg = tn;
      this.gc += clamp(tg - this.gc, -SL_SLOPE, SL_SLOPE);
      this.w += clamp(tw - this.w, -SL_SLOPE, SL_SLOPE);
      let y = this.gc ? x - mulq16(x, (this.gc << 1) >>> 0) : x;
      if (sd) {
        let z = sd[o + j];
        if (this.gc) z -= mulq16(z, (this.gc << 1) >>> 0);
        if (this.w) z -= mulq16(z, (this.w << 1) >>> 0);
        sd[o + j] = z;
      }
      if (this.recOn) {
        if ((this.pos + j) & 1) {
          this.buf[this.rec] = clamp((this.half + x) >> 3, -32768, 32767);
          if (++this.rec >= SL_LEN) this.recOn = false;
        } else this.half = x;
      }
      if (this.loop) {
        const rp = this.rp;
        let e = this.loop - 1 - rp;
        let r = this.buf[rp >> 1];
        if (rp & 1) r = (r + this.buf[((rp >> 1) + 1) & (SL_LEN - 1)]) >> 1;
        r <<= 2;
        if (rp < e) e = rp;
        if (left - 1 < e) e = left - 1;
        if (e < SL_RAMP) r = (r * e) >> SL_RAMP_LOG2;
        if (++this.rp >= this.loop) this.rp = 0;
        y += mulq16(r - y, (this.w << 1) >>> 0);
      } else if (this.w) {
        y -= mulq16(y, (this.w << 1) >>> 0);
      }
      b[o + j] = y;
    }
  }

  /**
   * The step clock over n samples and the SLICER on b (null: the clock only, the track is silent).
   * bpm: the song tempo; trackSwing: the track's plus the song's swing (0..100); sd: SPREAD's side signal.
   */
  process(s: SlicerSetting, b: Int32Array | null, n: number, bpm: number, trackSwing: number, sd?: Int32Array): void {
    const act = !!b && (s.mode !== SL_OFF || this.gc !== 0 || this.w !== 0);
    let i = 0;
    while (i < n) {
      if (this.pos >= this.len) this.enter(s, bpm, trackSwing);
      let m = this.len - this.pos;
      if (m > n - i) m = n - i;
      if (act) this.seg(s, b!, i, sd, m);
      this.pos += m;
      i += m;
    }
  }
}
