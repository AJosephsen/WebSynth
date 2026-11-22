// Port of fm6_core.c operator kernel and renderer (msfa FmCore). See NOTICE.
import { exp2, sin } from "./math";
import { ALG, OADD } from "./algorithms";
import { CTL, LG_N } from "./tables";

export interface Op {
  levelIn: number; // Q24 log2
  gainOut: number; // Q24
  freq: number; // Q24 cycles per sample
  phase: number; // Q24
}

const THRESH = 1120;

function opRun(out: Int32Array, inp: Int32Array | null, phase: number, freq: number, g1: number, g2: number, add: boolean): void {
  const dg = (g2 - g1 + (CTL >> 1)) >> LG_N;
  let g = g1;
  for (let i = 0; i < CTL; i++) {
    g += dg;
    const ph = inp ? (phase + inp[i]) | 0 : phase;
    const y = Math.floor((sin(ph) * g) / 32768) | 0;
    out[i] = add ? out[i] + y : y;
    phase = (phase + freq) | 0;
  }
}

function opFb(out: Int32Array, phase: number, freq: number, g1: number, g2: number, fb: Int32Array, shift: number, add: boolean): void {
  const dg = (g2 - g1 + (CTL >> 1)) >> LG_N;
  let g = g1;
  let y0 = fb[0];
  let y = fb[1];
  for (let i = 0; i < CTL; i++) {
    const s = (y0 + y) >> (shift + 1);
    g += dg;
    y0 = y;
    y = Math.floor((sin((phase + s) | 0) * g) / 32768) | 0;
    out[i] = add ? out[i] + y : y;
    phase = (phase + freq) | 0;
  }
  fb[0] = y0;
  fb[1] = y;
}

const bus = [new Int32Array(CTL), new Int32Array(CTL)];

/**
 * Renders one block of algorithm `alg` (0..31) into `out` (Q24). Returns false when nothing sounded.
 * `fb` holds the feedback operator's last two outputs; `fbShift` >= 16 turns feedback off.
 */
export function render(out: Int32Array, ops: Op[], alg: number, fb: Int32Array, fbShift: number): boolean {
  const a = ALG[alg & 31];
  const has = [false, false, false];
  for (let k = 0; k < 6; k++) {
    const f = a[k];
    const inbus = (f >> 4) & 3;
    const outbus = f & 3;
    let add = (f & OADD) !== 0;
    const o = outbus ? bus[outbus - 1] : out;
    const g1 = ops[k].gainOut;
    const g2 = exp2(ops[k].levelIn - (14 << 24));
    ops[k].gainOut = g2;
    if (g1 >= THRESH || g2 >= THRESH) {
      if (!has[outbus]) add = false;
      if (inbus === 0 || !has[inbus]) {
        if ((f & 0xc0) === 0xc0 && fbShift < 16) opFb(o, ops[k].phase, ops[k].freq, g1, g2, fb, fbShift, add);
        else opRun(o, null, ops[k].phase, ops[k].freq, g1, g2, add);
      } else {
        opRun(o, bus[inbus - 1], ops[k].phase, ops[k].freq, g1, g2, add);
      }
      has[outbus] = true;
    } else if (!add) {
      has[outbus] = false;
    }
    ops[k].phase = (ops[k].phase + (ops[k].freq << LG_N)) | 0;
  }
  return has[0];
}
