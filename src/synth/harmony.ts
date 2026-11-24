// Chord keys with AUTO harmony (Melodee's chord.c, chord_auto.c and chord_melody.c, GPL-3.0-only, after Felucca's chord.c). CHRD: OFF, DIA3 / DIA7,
// MAJ MIN DOM7 MAJ7 MIN7 SUS4 POW, AUTO (the chord the held and recent notes of every part ask for, chosen from 18 shapes inside the scale) and AUTO2
// (the key is the melody, always the top note, with a triad under it). VOIC: CLOSE, OPEN, INV1, INV2, +OCT. Microtonal scales build chords from
// their degrees. The state AUTO needs (each part's last chord, the recent melody notes, the clock) lives in `Harmony`. See NOTICE.
import { clamp } from "../engines/dsp";
import { FS } from "../engines/types";
import { KeyMapParams, microActive, microPitch, microScale, scaleMask, scaleNotePeriod } from "./keymap";
import { SCALE_MASK as WEST_MASK } from "./scales";

export const CH_OFF = 0, CH_DIA3 = 1, CH_DIA7 = 2, CH_MAJ = 3, CH_MIN = 4, CH_DOM7 = 5, CH_MAJ7 = 6, CH_MIN7 = 7, CH_SUS4 = 8, CH_POW = 9, CH_AUTO = 10, CH_MELODY = 11;
export const CHORD_MODES = ["OFF", "DIA3", "DIA7", "MAJ", "MIN", "DOM7", "MAJ7", "MIN7", "SUS4", "POW", "AUTO", "AUTO2"];
export const VC_CLOSE = 0, VC_OPEN = 1, VC_INV1 = 2, VC_INV2 = 3, VC_BASS = 4;
export const CHORD_MAX = 4;
const V_POLY = 0;
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const SHAPE = [[0, 4, 7, -1], [0, 3, 7, -1], [0, 4, 7, 10], [0, 4, 7, 11], [0, 3, 7, 10], [0, 5, 7, -1], [0, 7, 12, -1]];

/** What a part looks like to the chord keys. */
export interface HarmonyTrack extends KeyMapParams {
  chrd: number; voic: number;
  /** 0 POLY, 1 MONO, 2 LEGATO, 3 UNISON. */
  voice: number;
  /** The part's keys are a kit: no chords. */
  kit: boolean;
  mute: boolean;
  /** The keys held now (live_held: 128 bits in four words) and the arp's held count. */
  held: Uint32Array; nheld: number;
  /** The notes the track's sequencer sounds now. */
  seqNotes: number[];
  /** STRUM (0 OFF, then the sweep's length 1/8 .. 32T), STROKE (0 DOWN, 1 UP, 2 ALT) and the arpeggiator's mode (the ARP owns the timing). */
  strum: number; stroke: number; amode: number;
}
export const newHarmonyTrack = (): HarmonyTrack => ({
  scale: 1, root: 0, quant: 0, trans: 0, mpcdeg: 1, octave: 0, chrd: 0, voic: 0, voice: 0, kit: false, mute: false, held: new Uint32Array(4), nheld: 0, seqNotes: [], strum: 0, stroke: 0, amode: 0,
});

interface Remembered { n: number; note: number[]; root: number; mask: number; melody: number; scale: number; tonic: number; quant: number; voicing: number; at: number }
interface MelodyHist { n: number; next: number; note: number[]; at: number[] }
const blank = (): Remembered => ({ n: 0, note: [0, 0, 0, 0], root: 0, mask: 0, melody: 0, scale: 0, tonic: 0, quant: 0, voicing: 0, at: 0 });
const blankMel = (): MelodyHist => ({ n: 0, next: 0, note: [0, 0, 0, 0], at: [0, 0, 0, 0] });

const AUTO_SHAPE: { n: number; pitch: number[]; cost: number; name: string }[] = [
  { n: 3, pitch: [0, 4, 7], cost: 0, name: "" }, { n: 3, pitch: [0, 3, 7], cost: 0, name: "m" },
  { n: 3, pitch: [0, 3, 6], cost: 6, name: "dim" }, { n: 3, pitch: [0, 4, 8], cost: 6, name: "aug" },
  { n: 3, pitch: [0, 5, 7], cost: 12, name: "sus4" }, { n: 3, pitch: [0, 2, 7], cost: 12, name: "sus2" },
  { n: 4, pitch: [0, 4, 7, 10], cost: 16, name: "7" }, { n: 4, pitch: [0, 4, 7, 11], cost: 16, name: "maj7" },
  { n: 4, pitch: [0, 3, 7, 10], cost: 16, name: "m7" }, { n: 4, pitch: [0, 3, 6, 10], cost: 16, name: "m7b5" },
  { n: 4, pitch: [0, 3, 6, 9], cost: 16, name: "dim7" }, { n: 4, pitch: [0, 3, 7, 11], cost: 18, name: "mM7" },
  { n: 4, pitch: [0, 4, 8, 10], cost: 20, name: "+7" }, { n: 4, pitch: [0, 4, 8, 11], cost: 20, name: "+M7" },
  { n: 4, pitch: [0, 4, 7, 9], cost: 18, name: "6" }, { n: 4, pitch: [0, 3, 7, 9], cost: 18, name: "m6" },
  { n: 4, pitch: [0, 5, 7, 10], cost: 24, name: "7sus4" }, { n: 4, pitch: [0, 2, 7, 10], cost: 24, name: "7sus2" },
];
const MELODY_SHAPE: { pitch: number[]; cost: number; name: string }[] = [
  { pitch: [0, 4, 7], cost: 0, name: "" }, { pitch: [0, 3, 7], cost: 0, name: "m" },
  { pitch: [0, 3, 6], cost: 24, name: "dim" }, { pitch: [0, 4, 8], cost: 16, name: "aug" },
  { pitch: [0, 5, 7], cost: 18, name: "sus4" }, { pitch: [0, 2, 7], cost: 18, name: "sus2" },
];

const bits = (b: number): number => { let n = 0; b >>>= 0; while (b) { b &= b - 1; n++; } return n; };
/** The 12 pitch classes of `b` moved up by `semitones` (C's `%` on a signed value, then folded). */
const rotate = (b: number, semitones: number): number => {
  b &= 0xfff;
  const n = ((semitones % 12) + 12) % 12;
  return ((b << n) | (b >>> (12 - n))) & 0xfff;
};

export const STRUM_NAMES = ["OFF", "1/8", "1/16", "1/32", "1/64", "1/128", "16T", "32T"];
export const STROKE_NAMES = ["DOWN", "UP", "ALT"];
const STRUM_DEN = [1, 2, 4, 8, 16, 32, 6, 12];
/** A chord's sweep: the string being played, the rate frozen at the press and the beat length it was counted in. */
export interface Strum { pos: number; beat: number; total: number; rate: number; vel: number }
export const newStrum = (): Strum => ({ pos: 0, beat: 0, total: 0, rate: 0, vel: 0 });

export interface ChordResult { notes: number[]; root: number; mask: number }

export class Harmony {
  /** The samples elapsed (the clock AUTO's phrase gaps count in). */
  clock = 0;
  private enabled = 0;
  private readonly hist: Remembered[];
  private readonly mel: MelodyHist[];
  /** The last chord played per part (the CHORD page shows it): root, notes, tones, and how often it changed. */
  readonly last: { root: number; n: number; note: number[]; mask: number; gen: number }[];

  constructor(readonly tracks: HarmonyTrack[], private readonly host: { solo: () => number; beatSamples: () => number }) {
    this.hist = tracks.map(blank);
    this.mel = tracks.map(blankMel);
    this.last = tracks.map(() => ({ root: 0, n: 0, note: [0, 0, 0, 0], mask: 0, gen: 0 }));
  }

  private isMicro = (t: KeyMapParams): boolean => microScale(t) !== null;
  private config(t: HarmonyTrack, h: Remembered): boolean {
    return !!h.n && t.voice === V_POLY && h.scale === t.scale && h.tonic === t.root + t.trans && h.quant === t.quant && h.voicing === t.voic;
  }
  private same(t: HarmonyTrack, h: Remembered): boolean {
    return this.config(t, h) && ((this.clock - h.at) >>> 0) < ((2 * this.host.beatSamples()) >>> 0);
  }
  private alternate: number[] = [];
  /**
   * A division is the whole first-to-last sweep. Freezes the rate and the order at the press (UP reverses, ALT alternates; AUTO2 keeps its melody first) and
   * returns how many tones start now: all of them (STRUM OFF, one note, or the ARP on) or the first alone (the rest follow through `strumDue`).
   */
  strumBegin(k: number, notes: number[], n: number, s: Strum, vel: number, beat: number): number {
    const t = this.tracks[k];
    Object.assign(s, newStrum());
    const rate = t.strum;
    if (!rate || rate >= STRUM_NAMES.length || n < 2 || t.amode) return n;
    let up = t.stroke === 1;
    if (t.stroke === 2) up = (((this.alternate[k] = (this.alternate[k] ?? 0) + 1) - 1) & 1) === 1;
    if (up) for (let i = 0; i < Math.floor(n / 2); i++) { const x = notes[i]; notes[i] = notes[n - 1 - i]; notes[n - 1 - i] = x; }
    if (!up && t.chrd === CH_MELODY && !this.isMicro(t)) {
      // the melody sounds on the press; DOWN/UP/ALT order its accompaniment
      const melody = notes[n - 1];
      for (let i = n - 1; i; i--) notes[i] = notes[i - 1];
      notes[0] = melody;
    }
    s.total = n; s.rate = rate; s.vel = vel; s.beat = beat;
    return 1;
  }
  /** The samples until string `started` is due, after `elapsed` more samples (the elapsed fraction of a beat survives tempo changes). */
  strumDue(s: Strum, started: number, elapsed: number, beat: number): number {
    if (s.beat !== beat) { s.pos = Number((BigInt(s.pos) * BigInt(beat) + BigInt(Math.floor(s.beat / 2))) / BigInt(s.beat)); s.beat = beat; }
    s.pos = (s.pos + elapsed) >>> 0;
    const target = Math.floor((Math.floor(beat / STRUM_DEN[s.rate]) * started) / (s.total - 1));
    return s.pos < target ? target - s.pos : 0;
  }

  forget(k: number): void { this.hist[k] = blank(); this.mel[k] = blankMel(); }

  /** Advances the clock; expires the history of parts that no longer harmonise (chord_auto_tick). */
  tick(samples: number): void {
    this.clock = (this.clock + samples) >>> 0;
    let enabled = 0;
    const previous = this.enabled;
    this.tracks.forEach((t, k) => { if (t.chrd === CH_AUTO && !this.isMicro(t)) enabled |= 1 << k; });
    this.enabled = enabled;
    if (!enabled) {
      if (previous) for (let k = 0; k < this.tracks.length; k++) { this.hist[k] = blank(); this.mel[k] = blankMel(); }
      return;
    }
    this.tracks.forEach((t, k) => {
      const h = this.hist[k], m = this.mel[k];
      // a long held chord is still the current harmony: the phrase gap begins at release
      if (this.config(t, h) && (t.held[0] || t.held[1] || t.held[2] || t.held[3] || t.nheld)) h.at = this.clock;
      if (t.chrd !== CH_AUTO || this.isMicro(t) || (h.n && !this.same(t, h))) h.n = 0;
      if (t.chrd !== CH_OFF || this.isMicro(t)) m.n = 0;
      else if (m.n) {
        const newest = (m.next + 3) % 4;
        if (((this.clock - m.at[newest]) >>> 0) >= 8 * FS) m.n = 0;
      }
    });
  }

  /** A note a part plays while CHRD is OFF: AUTO of other parts listens to it (chord_auto_observe). */
  observe(k: number, note: number): void {
    const t = this.tracks[k];
    if (!this.enabled || t.chrd !== CH_OFF || this.isMicro(t) || t.kit || note > 127) return;
    const m = this.mel[k];
    if (!m.n) m.next = 0;
    const at = m.next;
    m.note[at] = note % 12;
    m.at[at] = this.clock;
    m.next = (at + 1) % 4;
    if (m.n < 4) m.n++;
  }

  private autoMelody(k: number, allowed: number): number {
    let pcs = 0;
    const solo = this.host.solo();
    for (let j = 0; j < this.tracks.length; j++) {
      const o = this.tracks[j];
      if (j === k || o.mute || (solo && !(solo & (1 << j))) || o.chrd !== CH_OFF || this.isMicro(o) || o.kit) continue;
      const m = this.mel[j];
      for (let i = 0; i < m.n; i++) if (((this.clock - m.at[i]) >>> 0) < ((2 * this.host.beatSamples()) >>> 0)) pcs |= 1 << m.note[i];
      for (let w = 0; w < 4; w++) {
        const b = o.held[w];
        pcs |= rotate((b | (b >>> 12) | (b >>> 24)) >>> 0, 32 * w);
      }
      for (const n of o.seqNotes) pcs |= 1 << (n % 12);
    }
    return pcs & allowed;
  }

  private tones(t: HarmonyTrack, mode: number, root: number): { n: number; root: number; iv: number[] } {
    const iv: number[] = [];
    if (microActive(t)) {
      if (mode < CH_MAJ) {
        const n = mode === CH_DIA7 ? 4 : 3;
        for (let i = 0; i < n; i++) iv.push(2 * i);
        return { n, root, iv };
      }
      for (let i = 0; i < CHORD_MAX && SHAPE[mode - CH_MAJ][i] >= 0; i++) {
        const target = microPitch(t, root) + SHAPE[mode - CH_MAJ][i] * 10000;
        let lo = 0, hi = 127;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (microPitch(t, mid) < target) lo = mid + 1; else hi = mid; }
        if (lo && target - microPitch(t, lo - 1) < microPitch(t, lo) - target) lo--;
        iv.push(lo - root);
      }
      return { n: iv.length, root, iv };
    }
    if (mode >= CH_MAJ) {
      for (let i = 0; i < CHORD_MAX && SHAPE[mode - CH_MAJ][i] >= 0; i++) iv.push(SHAPE[mode - CH_MAJ][i]);
      return { n: iv.length, root, iv };
    }
    let mask = scaleMask(t);
    const r = t.root;
    if (mask === 0xfff) mask = WEST_MASK[1];
    let guard = 12;
    while (guard-- && !((mask >> ((root - r + 120) % 12)) & 1)) root--;
    const deg: number[] = [];
    let at = 0;
    for (let i = 0; i < 12; i++) if ((mask >> i) & 1) { if (i === (root - r + 120) % 12) at = deg.length; deg.push(i); }
    const c = deg.length;
    for (let i = 0; i < (mode === CH_DIA7 ? 4 : 3); i++) {
      const k = at + 2 * i;
      iv.push(deg[k % c] + 12 * Math.floor(k / c) - deg[at]);
    }
    return { n: iv.length, root, iv };
  }

  /** AUTO's voicing: nearby inversions with CLOSE (the voice leading follows the last chord), explicit OPEN / INV / +OCT as the player chose. */
  private autoVoice(t: HarmonyTrack, root: number, pitch: number[], n: number, h: Remembered | null): number[] {
    let best = 0x7fffffff;
    const out: number[] = new Array(n).fill(0);
    const inversions = t.voic === VC_CLOSE ? n : 1;
    for (let inv = 0; inv < inversions; inv++) {
      const notes: number[] = [];
      for (let i = 0; i < n; i++) { const at = (i + inv) % n; notes[i] = root + pitch[at] + (at < inv ? 12 : 0); }
      if (t.voic === VC_OPEN && n >= 3) {
        const x = notes[1];
        for (let i = 1; i + 1 < n; i++) notes[i] = notes[i + 1];
        notes[n - 1] = x + 12;
      } else if (t.voic === VC_INV1 || t.voic === VC_INV2) {
        const count = t.voic === VC_INV2 ? 2 : 1;
        for (let j = 0; j < count; j++) {
          const x = notes[0] + 12;
          for (let i = 0; i + 1 < n; i++) notes[i] = notes[i + 1];
          notes[n - 1] = x;
        }
      } else if (t.voic === VC_BASS) {
        if (n === 4) notes[2] = notes[3];
        for (let i = n - 1; i; i--) notes[i] = notes[i - 1];
        notes[0] = root - 12;
      }
      for (let oct = -3; oct <= 1; oct++) {
        const low = notes[0] + 12 * oct, high = notes[n - 1] + 12 * oct;
        if (low < 0 || high > 127) continue;
        let score = Math.abs(oct) * 2 + inv;
        if (h && t.voic === VC_CLOSE) {
          for (let i = 0; i < n; i++) {
            let distance = 128;
            for (let j = 0; j < h.n; j++) { const d = Math.abs(notes[i] + 12 * oct - h.note[j]); if (d < distance) distance = d; }
            score += 4 * distance;
          }
          score += Math.abs(low - h.note[0]);
          score += Math.abs(notes[Math.floor(n / 2)] + 12 * oct - root - 4);
        } else score += 12 * Math.abs(oct) + 12 * inv;
        if (score >= best) continue;
        best = score;
        for (let i = 0; i < n; i++) out[i] = (notes[i] + 12 * oct) & 255;
      }
    }
    return out;
  }

  private autoMake(k: number, input: number): { notes: number[]; root: number; mask: number } {
    const t = this.tracks[k];
    const tonic = t.root + t.trans;
    let root = input;
    const allowed = rotate(scaleMask(t), tonic);
    while (root >= 0 && !(allowed & (1 << (root % 12)))) root--;
    if (root < 0) { root = 0; while (!(allowed & (1 << (root % 12)))) root++; }
    if (t.voice !== V_POLY) return { notes: [root], root, mask: 1 };
    const relative = rotate(allowed, -root), melody = this.autoMelody(k, allowed);
    let h: Remembered | null = this.hist[k];
    if (!this.same(t, h)) h = null;
    if (h && h.root === root && h.melody === melody) return { notes: h.note.slice(0, h.n), root, mask: h.mask };
    const degree: number[] = [];
    let natural = 0, chosen = 0xffff, n = 3, pitch: number[] = [];
    for (let i = 0; i < 12; i++) if (relative & (1 << i)) degree.push(i);
    const count = degree.length;
    if (count === 7) natural = 1 | (1 << degree[2]) | (1 << degree[4]);
    let best = 0x7fffffff;
    for (let i = 0; i < AUTO_SHAPE.length; i++) {
      const s = AUTO_SHAPE[i];
      let mask = 0;
      for (let j = 0; j < s.n; j++) mask |= 1 << s.pitch[j];
      if (mask & ~relative) continue;
      const pcs = rotate(mask, root);
      let score = s.cost + 32 * bits(melody & ~pcs);
      if (natural && (mask & natural) === natural) score -= 12;
      if (h) {
        const previous = rotate(h.mask, h.root);
        score -= 2 * bits(previous & pcs);
        const prev = (h.root - tonic + 120) % 12, now = (root - tonic + 120) % 12;
        // ii/IV -> V invites a dominant seventh when the scale permits it; V -> I prefers a settled triad
        if (now === 7 && (prev === 2 || prev === 5) && mask === 0x491) score -= 28;
        if (!now && prev === 7 && s.n === 3) score -= 8;
      }
      if (score < best) { best = score; chosen = i; }
    }
    let mask = 0;
    if (chosen < AUTO_SHAPE.length) { n = AUTO_SHAPE[chosen].n; pitch = AUTO_SHAPE[chosen].pitch.slice(0, n); }
    else { pitch = []; for (let i = 0; i < n; i++) pitch.push(degree[(2 * i) % count]); } // blues roots with no named triad: an honest in-scale set
    if (n === 3 && t.voic === VC_BASS) { pitch[3] = pitch[2]; n = 4; }
    for (let i = 0; i < n; i++) mask |= 1 << pitch[i];
    return { notes: this.autoVoice(t, root, pitch, n, h), root, mask };
  }

  private melodyMake(k: number, input: number): { notes: number[]; root: number; mask: number } {
    const t = this.tracks[k];
    const tonic = t.root + t.trans, allowed = rotate(scaleMask(t), tonic);
    let melody = input;
    while (melody >= 0 && !(allowed & (1 << (melody % 12)))) melody--;
    if (melody < 0) { melody = 0; while (!(allowed & (1 << (melody % 12)))) melody++; }
    const pc = melody % 12;
    if (t.voice !== V_POLY) return { notes: [melody], root: melody, mask: 1 };
    const below = (m: number, p: number): number => m - ((m - p + 12) % 12);
    let root = pc, chosen = 0xffff, mask = 0, best = 0x7fffffff;
    for (let degree = 0; degree < 12; degree++) {
      const r = (tonic + degree + 120) % 12;
      if (!(allowed & (1 << r))) continue;
      const rootCost = !degree ? 0 : degree === 7 ? 8 : degree === 5 ? 10 : 14;
      for (let s = 0; s < MELODY_SHAPE.length; s++) {
        let shape = 0;
        for (let j = 0; j < 3; j++) shape |= 1 << MELODY_SHAPE[s].pitch[j];
        const pcs = rotate(shape, r);
        if ((pcs & ~allowed) || !(pcs & (1 << pc))) continue;
        const score = rootCost + MELODY_SHAPE[s].cost - (r === pc ? 6 : 0);
        if (score < best) { best = score; root = r; chosen = s; mask = shape; }
      }
    }
    const notes: number[] = [];
    let n = 0;
    if (chosen < MELODY_SHAPE.length) {
      for (let i = 0; i < 3; i++) notes[n++] = below(melody, (root + MELODY_SHAPE[chosen].pitch[i]) % 12);
    } else {
      notes[n++] = melody;
      let note = melody, degree = 0;
      while (n < 3) { note--; if (allowed & (1 << ((note + 120) % 12))) { degree++; if (!(degree & 1)) notes[n++] = note; } }
      root = (notes[2] + 120) % 12;
      for (let i = 0; i < n; i++) mask |= 1 << ((notes[i] - root + 120) % 12);
    }
    for (let i = 1; i < n; i++) for (let j = i; j && notes[j] < notes[j - 1]; j--) { const x = notes[j]; notes[j] = notes[j - 1]; notes[j - 1] = x; }
    const voicing = t.voic;
    if (voicing === VC_OPEN) notes[0] -= 12;
    else if (voicing === VC_BASS || voicing === VC_INV1 || voicing === VC_INV2) {
      let bass = root;
      if (voicing !== VC_BASS && chosen < MELODY_SHAPE.length) bass = (root + MELODY_SHAPE[chosen].pitch[voicing === VC_INV1 ? 1 : 2]) % 12;
      let at = n;
      if (voicing !== VC_BASS) for (let i = 0; i + 1 < n; i++) if ((notes[i] + 120) % 12 === bass) { at = i; break; }
      let low = below(melody, bass);
      if (at === n) do { low -= 12; } while (low >= notes[0]);
      else while (low > notes[0]) low -= 12;
      notes[at] = low;
      if (at === n) n++;
    }
    const out: number[] = [];
    for (let i = 0; i < n; i++) if (notes[i] >= 0) out.push(notes[i] & 255);
    for (let i = 1; i < out.length; i++) for (let j = i; j && out[j] < out[j - 1]; j--) { const x = out[j]; out[j] = out[j - 1]; out[j - 1] = x; }
    if (out.length === 1) return { notes: out, root: melody, mask: 1 };
    return { notes: out, root, mask };
  }

  /** The chord on `root` as part k plays it now (read-only): its notes ascending, the root and the tones above it (bit i: i semitones; 0 = no chord). */
  make(k: number, rootNote: number): ChordResult {
    const t = this.tracks[k], mode = t.chrd;
    const automatic = mode === CH_AUTO || mode === CH_MELODY;
    let maskOut = 0;
    if (automatic && this.isMicro(t)) maskOut = 1;
    if (!mode || mode > CH_MELODY || t.kit || (automatic && this.isMicro(t))) return { notes: [rootNote], root: rootNote, mask: maskOut };
    if (mode === CH_AUTO) return this.autoMake(k, rootNote);
    if (mode === CH_MELODY) return this.melodyMake(k, rootNote);
    const tn = this.tones(t, mode, rootNote), iv = tn.iv;
    let n = tn.n;
    const r = tn.root, period = scaleNotePeriod(t);
    let mask = 0;
    for (let i = 0; i < n; i++) {
      mask |= 1 << (microActive(t) ? Math.trunc((microPitch(t, r + iv[i]) - microPitch(t, r) + 5000) / 10000) % 12 : iv[i] % 12);
    }
    if (t.voice !== V_POLY) return { notes: [clamp(r, 0, 127)], root: r, mask };
    switch (t.voic) {
      case VC_OPEN: if (n >= 3) iv[1] += period; break;
      case VC_INV2:
      case VC_INV1:
        for (let j = 0; j < (t.voic === VC_INV2 ? 2 : 1); j++) {
          const x = iv[0] + period;
          for (let i = 1; i < n; i++) iv[i - 1] = iv[i];
          iv[n - 1] = x;
        }
        break;
      case VC_BASS:
        if (n === CHORD_MAX) { iv[2] = iv[3]; n--; }
        for (let i = n; i > 0; i--) iv[i] = iv[i - 1];
        iv[0] = -period;
        n++;
        break;
      default: break;
    }
    for (let i = 1; i < n; i++) for (let j = i; j > 0 && iv[j - 1] > iv[j]; j--) { const x = iv[j]; iv[j] = iv[j - 1]; iv[j - 1] = x; }
    const out: number[] = [];
    for (let i = 0; i < n && out.length < CHORD_MAX; i++) {
      const x = r + iv[i];
      if (x < 0 || x > 127 || (out.length && out[out.length - 1] === (x & 255))) continue;
      if (microActive(t) && (microPitch(t, x) < 0 || microPitch(t, x) > 1270000)) continue;
      out.push(x);
    }
    if (!out.length) return { notes: [clamp(r, 0, 127)], root: r, mask };
    return { notes: out, root: r, mask };
  }

  /** `make` for a note played now: AUTO remembers its chord (the voice leading and the next choice follow it) and the CHORD page shows it. */
  build(k: number, rootNote: number): ChordResult {
    const t = this.tracks[k];
    const c = this.make(k, rootNote);
    const m = c.notes.length;
    if (t.chrd === CH_AUTO && !this.isMicro(t) && !t.kit && t.voice === V_POLY) {
      const h = this.hist[k];
      h.root = c.root & 255; h.mask = c.mask; h.n = m;
      for (let i = 0; i < m; i++) h.note[i] = c.notes[i];
      h.scale = t.scale; h.tonic = t.root + t.trans; h.quant = t.quant; h.voicing = t.voic;
      h.melody = this.autoMelody(k, rotate(scaleMask(t), h.tonic));
      h.at = this.clock;
    }
    if (m > 1 || t.chrd === CH_MELODY) {
      const l = this.last[k];
      l.root = clamp(c.root, 0, 127); l.mask = c.mask; l.n = m;
      for (let i = 0; i < CHORD_MAX; i++) l.note[i] = i < m ? c.notes[i] : 0;
      l.gen = (l.gen + 1) & 255;
    }
    return c;
  }
}

/** A chord's name from its root and tones (bit i: i semitones above the root): "C", "Cm7", "F#m7b5", "Gsus4", "A5". */
export function chordName(root: number, mask: number): string {
  const mi = (mask >> 3) & 1, ma = (mask >> 4) & 1, b5 = (mask >> 6) & 1, p5 = (mask >> 7) & 1;
  const s5 = (mask >> 8) & 1, d7 = (mask >> 9) & 1, m7 = (mask >> 10) & 1, M7 = (mask >> 11) & 1;
  let q: string, x = "";
  if (mi && !ma && b5 && !p5) q = d7 ? "dim7" : m7 ? "m7b5" : "dim";
  else if (ma && !mi && s5 && !p5) q = m7 ? "+7" : M7 ? "+M7" : "aug";
  else if (ma && !mi) q = m7 ? "7" : M7 ? "maj7" : d7 ? "6" : "";
  else if (mi) q = m7 ? "m7" : M7 ? "mM7" : d7 ? "m6" : "m";
  else if ((mask >> 5) & 1) { q = m7 ? "7" : ""; x = "sus4"; }
  else if ((mask >> 2) & 1) { q = m7 ? "7" : ""; x = "sus2"; }
  else q = "5";
  return (NOTE_NAMES[root % 12] + q + x).slice(0, 11);
}
/** The name of an AUTO chord (a shape's name, or "set" for a note set that has none; the root alone has no suffix). */
export function autoChordName(root: number, mask: number): string {
  let name = mask === 1 ? "" : " set";
  for (const s of AUTO_SHAPE) { let shape = 0; for (let j = 0; j < s.n; j++) shape |= 1 << s.pitch[j]; if (shape === mask) { name = s.name; break; } }
  return (NOTE_NAMES[root % 12] + name).slice(0, 11);
}
/** The name of an AUTO2 chord (a triad shape's name, or "set"). */
export function melodyChordName(root: number, mask: number): string {
  let name = mask === 1 ? "" : " set";
  for (const s of MELODY_SHAPE) { let shape = 0; for (let j = 0; j < 3; j++) shape |= 1 << s.pitch[j]; if (shape === mask) { name = s.name; break; } }
  return (NOTE_NAMES[root % 12] + name).slice(0, 11);
}
