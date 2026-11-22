// Port of fm6_core.c envelope, pitch envelope and LFO (msfa env.cc, pitchenv.cc, lfo.cc). See NOTICE.
import { FP } from "./patch";
import { CTL, LG_N } from "./tables";
import { LEVELLUT, STATICS, PENV_RATE, PENV_TAB, LFO_DELTA, LFO_UNIT, PENV_UNIT } from "./data";
import { sin } from "./math";

export function scaleout(ol: number): number {
  return ol >= 20 ? 28 + ol : LEVELLUT[ol < 0 ? 0 : ol];
}

export class Env {
  level = 0; target = 0; inc = 0; statc = 0;
  outlevel = 0; rscale = 0; ix = 0; rising = false; down = true;

  /** op: the patch's operator bytes start at `o`. */
  init(p: Uint8Array, o: number, outlevel: number, rateScaling: number): void {
    this.outlevel = outlevel;
    this.rscale = rateScaling;
    this.level = 0;
    this.down = true;
    this.advance(p, o, 0);
  }

  advance(p: Uint8Array, o: number, ix: number): void {
    this.ix = ix;
    if (ix >= 4) return;
    const lv = p[o + FP.L1 + ix];
    let actual = scaleout(lv) >> 1;
    actual = (actual << 6) + this.outlevel - 4256;
    actual = actual < 16 ? 16 : actual;
    this.target = actual << 16;
    this.rising = this.target > this.level;
    let qrate = ((p[o + FP.R1 + ix] * 41) >> 6) + this.rscale;
    qrate = qrate > 63 ? 63 : qrate;
    if (this.target === this.level || (ix === 0 && lv === 0)) {
      let sr = p[o + FP.R1 + ix] + this.rscale;
      sr = sr > 99 ? 99 : sr;
      this.statc = sr < 77 ? STATICS[sr] : 20 * (99 - sr);
      if (sr < 77 && ix === 0 && lv === 0) this.statc = Math.trunc(this.statc / 20);
    } else {
      this.statc = 0;
    }
    this.inc = (4 + (qrate & 3)) << (2 + LG_N + (qrate >> 2));
  }

  get(p: Uint8Array, o: number): number {
    if (this.statc) {
      this.statc -= CTL;
      if (this.statc <= 0) {
        this.statc = 0;
        this.advance(p, o, this.ix + 1);
      }
    }
    if (this.ix < 3 || (this.ix < 4 && !this.down)) {
      if (this.statc) {
        // holding
      } else if (this.rising) {
        if (this.level < 1716 << 16) this.level = 1716 << 16;
        this.level += (((17 << 24) - this.level) >> 24) * this.inc;
        if (this.level >= this.target) {
          this.level = this.target;
          this.advance(p, o, this.ix + 1);
        }
      } else {
        this.level -= this.inc;
        if (this.level <= this.target) {
          this.level = this.target;
          this.advance(p, o, this.ix + 1);
        }
      }
    }
    return this.level;
  }

  key(p: Uint8Array, o: number, down: boolean): void {
    if (this.down !== down) {
      this.down = down;
      this.advance(p, o, down ? 0 : 3);
    }
  }
}

export class PitchEnv {
  level = 0; target = 0; inc = 0; ix = 0; rising = false; down = true;

  private advance(p: Uint8Array, ix: number): void {
    this.ix = ix;
    if (ix < 4) {
      this.target = PENV_TAB[p[FP.PL1 + ix] % 100] * (1 << 19);
      this.rising = this.target > this.level;
      this.inc = PENV_RATE[p[FP.PR1 + ix] % 100] * PENV_UNIT;
    }
  }

  init(p: Uint8Array): void {
    this.level = PENV_TAB[p[FP.PL1 + 3] % 100] * (1 << 19);
    this.down = true;
    this.advance(p, 0);
  }

  get(p: Uint8Array): number {
    if (this.ix < 3 || (this.ix < 4 && !this.down)) {
      if (this.rising) {
        this.level += this.inc;
        if (this.level >= this.target) { this.level = this.target; this.advance(p, this.ix + 1); }
      } else {
        this.level -= this.inc;
        if (this.level <= this.target) { this.level = this.target; this.advance(p, this.ix + 1); }
      }
    }
    return this.level;
  }

  key(p: Uint8Array, down: boolean): void {
    if (this.down !== down) {
      this.down = down;
      this.advance(p, down ? 0 : 3);
    }
  }
}

export class Lfo {
  phase = 0; delta = 0; dstate = 0; dinc = 0; dinc2 = 0; wave = 0; rnd = 0; sync = false;

  reset(p: Uint8Array): void {
    let a = 99 - (p[FP.LFD] % 100);
    this.delta = LFO_DELTA[p[FP.LFS] % 100];
    if (a === 99) {
      this.dinc = this.dinc2 = 0xffffffff;
    } else {
      a = (16 + (a & 15)) << (1 + (a >> 4));
      this.dinc = LFO_UNIT * a;
      a &= 0xff80;
      a = a < 0x80 ? 0x80 : a;
      this.dinc2 = LFO_UNIT * a;
    }
    this.wave = p[FP.LFW];
    this.sync = p[FP.LKS] !== 0;
  }

  /** 0..1 in Q24, once a block. */
  sample(): number {
    this.phase = (this.phase + this.delta) >>> 0;
    const ph = this.phase;
    switch (this.wave) {
      case 0: {
        let x = ph >>> 7;
        x ^= -(ph >>> 31);
        return x & ((1 << 24) - 1);
      }
      case 1: return (~ph ^ 0x80000000) >>> 8;
      case 2: return (ph ^ 0x80000000) >>> 8;
      case 3: return ((~ph >>> 7) & (1 << 24)) >>> 0;
      case 4: return (1 << 23) + sin(ph >>> 8) * 256;
      case 5:
        if (ph < this.delta) this.rnd = (this.rnd * 179 + 17) & 0xff;
        return ((this.rnd ^ 0x80) + 1) << 16;
    }
    return 1 << 23;
  }

  /** The delay ramp, 0..1 in Q24, once a block. */
  delay(): number {
    const d = this.dstate < 0x80000000 ? this.dinc : this.dinc2;
    const s = this.dstate + d;
    if (s >= 0x100000000) return 1 << 24;
    this.dstate = s;
    return s < 0x80000000 ? 0 : Math.floor(s / 128) & ((1 << 24) - 1);
  }

  key(): void {
    if (this.sync) this.phase = 0x7fffffff;
    this.dstate = 0;
  }
}
