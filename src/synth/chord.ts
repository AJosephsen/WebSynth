// Chord keys: one key plays a chord (Felucca's chord.c, GPL-3.0-only). CHRD: OFF, DIA3 / DIA7 (the triad / seventh of the
// scale built on the key, every tone in key), MAJ MIN DOM7 MAJ7 MIN7 SUS4 POW (that shape on the key); VOIC: CLOSE, OPEN,
// INV1, INV2, +OCT. At most four notes; MONO / LEGATO / UNISON parts play the chord's root only. See NOTICE.
import { clamp } from "../engines/dsp";

export const CHORD_NAMES = ["OFF", "DIA3", "DIA7", "MAJ", "MIN", "DOM7", "MAJ7", "MIN7", "SUS4", "POW"];
export const VOICING_NAMES = ["CLOSE", "OPEN", "INV1", "INV2", "+OCT"];
export const SCALE_NAMES = ["CHR", "MAJ", "MIN", "DOR", "MIX", "PEN", "MPEN", "HARM", "PHRY", "LYD", "LOC", "MEL", "BLUES", "WHOLE", "DIMHW", "DIMWH"];
const b = (...n: number[]): number => n.reduce((m, x) => m | (1 << x), 0);
export const SCALE_MASK = [
  0xfff, b(0, 2, 4, 5, 7, 9, 11), b(0, 2, 3, 5, 7, 8, 10), b(0, 2, 3, 5, 7, 9, 10), b(0, 2, 4, 5, 7, 9, 10), b(0, 2, 4, 7, 9),
  b(0, 3, 5, 7, 10), b(0, 2, 3, 5, 7, 8, 11), b(0, 1, 3, 5, 7, 8, 10), b(0, 2, 4, 6, 7, 9, 11), b(0, 1, 3, 5, 6, 8, 10),
  b(0, 2, 3, 5, 7, 9, 11), b(0, 3, 5, 6, 7, 10), b(0, 2, 4, 6, 8, 10), b(0, 1, 3, 4, 6, 7, 9, 10), b(0, 2, 3, 5, 6, 8, 9, 11),
];

const CH_DIA7 = 2, CH_MAJ = 3, CH_POW = 9;
const VC_OPEN = 1, VC_INV1 = 2, VC_INV2 = 3, VC_BASS = 4;
const CHORD_MAX = 4;
const SHAPE = [[0, 4, 7, -1], [0, 3, 7, -1], [0, 4, 7, 10], [0, 4, 7, 11], [0, 3, 7, 10], [0, 5, 7, -1], [0, 7, 12, -1]];

export interface ChordParams {
  chrd: number; voic: number; root: number; scale: number;
  /** 0 POLY, 1 MONO, 2 LEGATO, 3 UNISON. */
  voice: number;
  /** The part's keys are a kit (DRUM, slices): no chords. */
  kit?: boolean;
}

function tones(p: ChordParams, mode: number, rootIn: number): { n: number; root: number; iv: number[] } {
  const iv: number[] = [];
  let root = rootIn;
  if (mode >= CH_MAJ) {
    for (let i = 0; i < CHORD_MAX && SHAPE[mode - CH_MAJ][i] >= 0; i++) iv.push(SHAPE[mode - CH_MAJ][i]);
    return { n: iv.length, root, iv };
  }
  let mask = SCALE_MASK[clamp(p.scale, 0, SCALE_MASK.length - 1)];
  const r = p.root;
  if (mask === 0xfff) mask = SCALE_MASK[1];
  let guard = 12;
  while (guard-- && !((mask >> (((root - r + 120) % 12 + 12) % 12)) & 1)) root--;
  const deg: number[] = [];
  let at = 0;
  for (let i = 0; i < 12; i++) {
    if ((mask >> i) & 1) {
      if (i === ((root - r + 120) % 12 + 12) % 12) at = deg.length;
      deg.push(i);
    }
  }
  const c = deg.length;
  for (let i = 0; i < (mode === CH_DIA7 ? 4 : 3); i++) {
    const k = at + 2 * i;
    iv.push(deg[k % c] + 12 * Math.floor(k / c) - deg[at]);
  }
  return { n: iv.length, root, iv };
}

/** The chord on `rootNote` as the part plays it: its notes (ascending), the root it was built on and its tone mask. */
export function chordMake(p: ChordParams, rootNote: number): { notes: number[]; root: number; mask: number } {
  const mode = p.chrd;
  if (!mode || mode > CH_POW || p.kit) return { notes: [rootNote], root: rootNote, mask: 0 };
  const t = tones(p, mode, rootNote);
  const iv = t.iv;
  let n = t.n;
  const r = t.root;
  let mask = 0;
  for (let i = 0; i < n; i++) mask |= 1 << (iv[i] % 12);
  if (p.voice !== 0) return { notes: [clamp(r, 0, 127)], root: r, mask };
  switch (p.voic) {
    case VC_OPEN:
      if (n >= 3) iv[1] += 12;
      break;
    case VC_INV2:
    case VC_INV1:
      for (let j = 0; j < (p.voic === VC_INV2 ? 2 : 1); j++) {
        const x = iv[0] + 12;
        for (let i = 1; i < n; i++) iv[i - 1] = iv[i];
        iv[n - 1] = x;
      }
      break;
    case VC_BASS:
      if (n === CHORD_MAX) { iv[2] = iv[3]; n--; }
      for (let i = n; i > 0; i--) iv[i] = iv[i - 1];
      iv[0] = -12;
      n++;
      break;
    default:
      break;
  }
  for (let i = 1; i < n; i++) {
    for (let j = i; j > 0 && iv[j - 1] > iv[j]; j--) { const x = iv[j]; iv[j] = iv[j - 1]; iv[j - 1] = x; }
  }
  const out: number[] = [];
  for (let i = 0; i < n && out.length < CHORD_MAX; i++) {
    const x = r + iv[i];
    if (x < 0 || x > 127 || (out.length && out[out.length - 1] === (x & 255))) continue;
    out.push(x);
  }
  if (!out.length) return { notes: [clamp(r, 0, 127)], root: r, mask };
  return { notes: out, root: r, mask };
}
