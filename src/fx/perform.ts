// The performance layer of Felucca's FX hold keys (perform.c, GPL-3.0-only): REV THROW, ECHO THROW, the track mutes and the
// THROW macro. The effects are held (a bit each); shares glide in and out so nothing clicks. See NOTICE.
import { clamp, mulq15, mulq16 } from "../engines/dsp";
import { LEVEL_Q12 } from "../engines/felucca-tables";

export const PF_RTHR = 12, PF_ETHR = 13, PF_M1 = 14; // bit numbers of the held effects; the mutes are PF_M1 .. PF_M1 + 3
const THR_SLOPE = 64; // sends' glide a sample, Q15 (11.6 ms end to end)
const SL_SLOPE = 32768 / 128; // mutes and THROW: a 2.9 ms ramp
export const NTRK = 4;

/** The layer's state; per block call begin(), then mute() / throwSend() per track and pre() once. */
export class Perform {
  /** The effects held, one bit each (PF_*). */
  held = 0;
  /** THROW macro (KNOB 3), 0..100. */
  throwMacro = 0;
  act = 0;
  rw = 0; ew = 0; rw1 = 0; ew1 = 0;
  thr = false;
  muteMask = 0;
  readonly mg = [32768, 32768, 32768, 32768];
  private td = 0;

  hold(bit: number, on: boolean): void {
    this.held = on ? (this.held | (1 << bit)) >>> 0 : (this.held & ~(1 << bit)) >>> 0;
  }

  /** True while anything runs (so an idle layer costs nothing). */
  get busy(): boolean { return !!(this.held || this.thr || this.muteMask || this.td || this.throwMacro); }

  begin(n: number): void {
    const held = this.held;
    this.act = held;
    const s = THR_SLOPE * n;
    this.rw = this.rw1;
    this.ew = this.ew1;
    this.rw1 += clamp((held & (1 << PF_RTHR) ? 32768 : 0) - this.rw1, -s, s);
    this.ew1 += clamp((held & (1 << PF_ETHR) ? 32768 : 0) - this.ew1, -s, s);
    this.thr = (this.rw | this.rw1 | this.ew | this.ew1) !== 0;
    this.muteMask = 0;
    for (let k = 0; k < NTRK; k++) if (((held >>> (PF_M1 + k)) & 1) || this.mg[k] !== 32768) this.muteMask |= 1 << k;
  }

  /** A track muted by its key: its signal ramps to 0 and back. */
  mute(k: number, b: Int32Array, n: number): void {
    let g = this.mg[k];
    const t = (this.act >>> (PF_M1 + k)) & 1 ? 0 : 32768;
    for (let i = 0; i < n; i++) {
      g += clamp(t - g, -SL_SLOPE, SL_SLOPE);
      b[i] = mulq16(b[i], (g << 1) >>> 0);
    }
    this.mg[k] = g;
  }

  /** Before the buses: THROW adds the dry mix to the delay and reverb sends. */
  pre(ml: Int32Array, mr: Int32Array, sd: Int32Array, sr: Int32Array, n: number): void {
    const m = this.throwMacro * 327;
    for (let i = 0; i < n; i++) {
      this.td += clamp(m - this.td, -SL_SLOPE, SL_SLOPE);
      if (this.td) {
        const x = mulq16((ml[i] + mr[i]) >> 1, (this.td << 1) >>> 0);
        sd[i] += x;
        sr[i] += x;
      }
    }
  }

  /** REV / ECHO THROW: a track's reverb / delay send towards full while held (b: its signal as the sends take it). */
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
}
