// The key map of a part (Melodee's seq.c kb_map / midi_map / scale_map and microtonal.h, GPL-3.0-only, after Felucca's QNT): QNT OFF, SNAP (every key
// rounded down to the scale), WHITE (the white keys walk the scale), ALL (every key the next scale degree) and MPC (pads walk the scale); ROOT and TRN;
// and the 54 microtonal scales, where a note is a scale degree and its pitch comes from the table. See NOTICE.
import { clamp } from "../engines/dsp";
import { MICRO_SCALE, SCALE_LEGACY, SCALE_MASK, SCALE_TOTAL } from "./scales";

export const Q_OFF = 0, Q_SNAP = 1, Q_WHITE = 2, Q_ALL = 3, Q_MPC = 4;
export const QUANT_NAMES = ["OFF", "SNAP", "WHITE", "ALL", "MPC"];
export const KB_SILENT = 255;

/** What the key map reads of a part (the track's ROOT, SCALE, QNT, TRN, MPC degree and the input octave). */
export interface KeyMapParams {
  scale: number; root: number; quant: number; trans: number;
  /** QNT MPC: the scale degree pad 02 of each bank plays, 1 = root. */
  mpcdeg: number;
  /** The input octave (the octave buttons), in octaves. */
  octave: number;
  /** The part is a drum engine: microtonal scales do not apply. */
  drum?: boolean;
}
export const defaultKeyMap = (): KeyMapParams => ({ scale: 1, root: 0, quant: Q_OFF, trans: 0, mpcdeg: 1, octave: 0 });

/** C's integer division and remainder. */
const div = (a: number, b: number): number => Math.trunc(a / b);
const rem = (a: number, b: number): number => a - Math.trunc(a / b) * b;

/** The pitch table of a microtonal scale (hundredths of a cent; the last entry is the period), or null. */
export const microScale = (p: KeyMapParams): readonly number[] | null => (p.scale >= SCALE_LEGACY && p.scale < SCALE_TOTAL ? MICRO_SCALE[p.scale - SCALE_LEGACY] : null);
export const microCount = (s: readonly number[]): number => s.length - 1;
export const microActive = (p: KeyMapParams): boolean => p.quant !== Q_OFF && !p.drum && microScale(p) !== null;
const microFloor = (n: number, d: number): number => div(n, d) - (rem(n, d) < 0 ? 1 : 0);

/** The pitch of a note in a microtonal scale, in 1/10000 semitone. */
export function microPitch(p: KeyMapParams, note: number): number {
  const s = microScale(p)!, count = microCount(s), d = note - 60, cycle = microFloor(d, count);
  return (60 + p.root + p.trans) * 10000 + cycle * s[count] + s[d - cycle * count];
}
/** Scale degree `degree` (+ offset semitones, in whole octaves of the scale) as a note; strict: off the range is silent. */
export function microDegreeMap(p: KeyMapParams, degree: number, offset: number, strict: boolean): number {
  const s = microScale(p)!;
  const note = 60 + degree + div(offset, 12) * microCount(s);
  const pitch = microPitch(p, note);
  if (note < 0 || note > 127 || (strict && (pitch < 0 || pitch > 1270000))) return KB_SILENT;
  return note;
}
/** A pitch (semitones from C4 + ROOT + TRN) rounded to the nearest degree of the microtonal scale. */
export function microSnap(p: KeyMapParams, pitch: number): number {
  const s = microScale(p)!, count = microCount(s);
  let relative = (pitch - 60 - p.root - p.trans) * 10000;
  const cycle = microFloor(relative, s[count]);
  let degree = 0;
  relative -= cycle * s[count];
  while (degree + 1 < count && s[degree + 1] <= relative) degree++;
  if (s[degree + 1] - relative < relative - s[degree]) degree++;
  return microDegreeMap(p, cycle * count + degree, 0, true);
}
/** Notes in one repeat of the scale: 12, or the degrees of a microtonal scale. */
export const scaleNotePeriod = (p: KeyMapParams): number => (microActive(p) ? microCount(microScale(p)!) : 12);
/** A note's pitch in 1/16 semitone (clamped to the MIDI range) and the part below it in 1/2367-ish fine units (Melodee voice.c voice_scale_pitch). */
export function scalePitch(p: KeyMapParams, note: number): { pitch16: number; fine: number } {
  if (!microActive(p)) return { pitch16: note * 16, fine: 0 };
  const pitch = clamp(microPitch(p, note), 0, 1270000);
  const pitch16 = div(pitch * 16, 10000);
  return { pitch16, fine: div((pitch * 16 - pitch16 * 10000) * 2367, 1600000) };
}

/** The pitch classes of the scale (for the keyboard's lights); a microtonal scale's are approximate. */
export function scaleMask(p: KeyMapParams): number {
  const s = microScale(p);
  if (s) {
    let mask = 0;
    for (let i = 0; i < microCount(s); i++) mask |= 1 << (rem(div(s[i] + 5000, 10000), 12));
    return mask;
  }
  return SCALE_MASK[clamp(p.scale, 0, SCALE_LEGACY - 1)];
}
const popcount = (m: number): number => { let c = 0; for (; m; m >>>= 1) c += m & 1; return c; };
/** The degrees in one repeat of the scale. */
export const scaleCount = (p: KeyMapParams): number => (microScale(p) ? microCount(microScale(p)!) : popcount(scaleMask(p)));
const mpcDegree = (p: KeyMapParams): number => clamp(p.mpcdeg, 1, scaleCount(p));

/** Scale degree `degree` from C4 (0 = the ROOT above C4) in the part's scale, + offset semitones and TRN; strict: a note off the MIDI range is silent. */
export function scaleDegreeMap(p: KeyMapParams, degree: number, offset: number, strict: boolean): number {
  if (microActive(p)) return microDegreeMap(p, degree, offset, strict);
  const mask = scaleMask(p), count = scaleCount(p);
  let oct = div(degree, count);
  degree = rem(degree, count);
  if (degree < 0) { degree += count; oct--; }
  let i = 0;
  for (; i < 12; i++) if ((mask >> i) & 1) { if (!degree) break; degree--; }
  const n = 60 + p.root + 12 * oct + i + offset + p.trans;
  if (strict && (n < 0 || n > 127)) return KB_SILENT;
  return clamp(n, 0, 127);
}

const DEGREE = [0, -1, 1, -1, 2, 3, -1, 4, -1, 5, -1, 6];
/** A key's or a MIDI note's number through the WHITE / ALL layouts (and MPC on the keys). */
export function scaleMap(p: KeyMapParams, n: number, offset: number): number {
  if (p.quant === Q_ALL) return scaleDegreeMap(p, n - 60, offset, true);
  if (p.quant === Q_WHITE || p.quant === Q_MPC) {
    const degree = DEGREE[n % 12];
    if (degree < 0) return KB_SILENT;
    return scaleDegreeMap(p, degree + (Math.floor(n / 12) - 5) * 7, offset, false);
  }
  return clamp(n + offset + p.trans, 0, 127);
}

/** The note key k of the on-screen keyboard (0..26, from F3) plays. */
export function keyNote(p: KeyMapParams, k: number): number {
  let n = 53 + k;
  if (p.quant === Q_SNAP) {
    if (microActive(p)) {
      const note = microSnap(p, n + p.trans);
      return note === KB_SILENT ? note : microDegreeMap(p, note - 60, 12 * p.octave, true);
    }
    const mask = scaleMask(p);
    let guard = 12;
    n += 12 * p.octave + p.trans;
    while (guard-- && !((mask >> ((n - p.root + 120) % 12)) & 1)) n--;
    return clamp(n, 0, 127);
  }
  return scaleMap(p, n, 12 * p.octave);
}

/** MPC: a note's pad, E01..H16 as 0..63 (A..D are 64..127). */
export const mpcPad = (note: number): number => (note + 28) & 127;

/** A MIDI note into the part (WHITE and ALL map it as the keys; MPC banks E..H play parts 1..4; the kits keep their own maps): the note it plays, or KB_SILENT. */
export function midiNote(p: KeyMapParams, note: number, track = 0): number {
  const pad = mpcPad(note);
  if (p.quant === Q_MPC && Math.floor(pad / 16) !== track) return KB_SILENT;
  if (p.quant === Q_MPC) return scaleDegreeMap(p, (pad & 15) - 1 + mpcDegree(p) - 1, 12 * p.octave, true);
  if (p.quant === Q_WHITE || p.quant === Q_ALL) return scaleMap(p, note, 0);
  if (microActive(p) && p.quant === Q_SNAP) return microSnap(p, note + p.trans);
  return note;
}
