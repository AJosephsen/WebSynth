// The note input of a part: the key map (QNT, ROOT, TRN, scales), chord keys with AUTO harmony and strum, and the arpeggiator in front of a synth
// (seq.c input_on / input_off, key_on / key_off, chord_strum_tick). A key's chord is remembered, so its release ends exactly the notes it started.
// See NOTICE.
import { Arp, ArpParams, defaultArp } from "./arp";
import { ClockGrid, clockPeriod, clockScale } from "../seq/midiclock";
import { CH_OFF, Harmony, HarmonyTrack, Strum, newHarmonyTrack, newStrum } from "./harmony";
import { KB_SILENT, KeyMapParams, keyMapNote, midiNote } from "./keymap";
import type { Synth } from "./synth";

export interface ChordSetting {
  chrd: number; voic: number; root: number; scale: number;
  /** QNT: 0 OFF, 1 SNAP, 2 WHITE, 3 ALL, 4 MPC. */
  quant?: number; trans?: number; mpcdeg?: number;
  /** STRUM (0 OFF, then the sweep's length) and STROKE (0 DOWN, 1 UP, 2 ALT). */
  strum?: number; stroke?: number;
}
export interface InputSettings { arp: ArpParams; chord: ChordSetting }
export const defaultInput = (): InputSettings => ({ arp: defaultArp(), chord: { chrd: 0, voic: 0, root: 0, scale: 1, quant: 0, trans: 0, mpcdeg: 1, strum: 0, stroke: 0 } });

/** What the input shares with the other parts: the harmony state AUTO listens with, and this part's place in it. */
export interface InputContext { harmony: Harmony; index: number }

interface Held { notes: number[]; started: number; strum: Strum; vel: number }

export class NoteInput {
  settings: InputSettings = defaultInput();
  private readonly arp: Arp;
  private readonly chords = new Map<number, Held>();
  private readonly pending = new Set<number>();
  private quarter = 22050;
  /** The chord last played (its name is built from this by the page). */
  /** A tone starts (on) or ends: the sequencer's recorder listens. */
  onTone?: (note: number, vel: number, on: boolean) => void;
  onChord?: (c: { notes: number[]; root: number; mask: number; chrd: number }) => void;

  private readonly ctx: InputContext;

  constructor(private readonly synth: () => Synth, ctx?: InputContext) {
    this.ctx = ctx ?? { harmony: new Harmony([newHarmonyTrack()], { solo: () => 0, beatSamples: () => this.quarter }), index: 0 };
    this.arp = new Arp({ on: (n, v) => this.synth().noteOn(n, v), off: (n) => this.synth().noteOff(n) });
  }

  set(s: InputSettings): void {
    const wasOn = this.arp.p.mode !== 0;
    this.settings = s;
    this.arp.p = s.arp;
    if (wasOn && !s.arp.mode) this.arp.stopNotes();
    this.sync();
  }

  /** The part as the key map and the harmony see it: its settings and its synth. */
  private ht(): HarmonyTrack {
    return this.ctx.harmony.tracks[this.ctx.index];
  }
  private keyMap(): KeyMapParams {
    const s = this.synth(), c = this.settings.chord;
    const micro = typeof s.setScale === "function";
    return { scale: micro || c.scale < 16 ? c.scale : 1, root: c.root, quant: c.quant ?? 0, trans: c.trans ?? 0, mpcdeg: c.mpcdeg ?? 1, octave: 0, drum: !!s.keyKit };
  }
  /** Copies the settings and the synth's state into the harmony's view of this part. */
  private sync(): void {
    const t = this.ht();
    const s = this.synth(), c = this.settings.chord, km = this.keyMap();
    Object.assign(t, km, {
      chrd: c.chrd, voic: c.voic, voice: s.voiceMode ?? 0, kit: !!s.keyKit, strum: c.strum ?? 0, stroke: c.stroke ?? 0, amode: this.arp.p.mode ? 1 : 0, nheld: this.arp.held.length,
    });
    s.setScale?.(km.scale >= 16 && km.quant !== 0 ? km : null);
  }

  /**
   * A key or MIDI note goes down. `source` "key": the on-screen / computer keys (the key map's QNT layouts); "midi": a MIDI note (WHITE, ALL and MPC
   * map it; SNAP only for the microtonal scales).
   */
  noteOn(note: number, vel = 100, source: "key" | "midi" = "key"): void {
    const s = this.synth();
    this.sync();
    const km = this.keyMap();
    let mapped = note;
    if (!s.keyKit) mapped = source === "midi" ? midiNote(km, note, this.ctx.index) : keyMapNote(km, note);
    if (mapped === KB_SILENT) return;
    const h = this.ctx.harmony, idx = this.ctx.index;
    const prev = this.chords.get(note);
    if (prev) this.release(prev);
    const strum = newStrum();
    const r = h.build(idx, mapped);
    const notes = r.notes.slice();
    const started = h.strumBegin(idx, notes, notes.length, strum, vel, this.quarter);
    this.onChord?.({ notes: r.notes.slice(), root: r.root, mask: r.mask, chrd: this.settings.chord.chrd });
    const held: Held = { notes, started: 0, strum, vel };
    this.chords.set(note, held);
    for (let i = 0; i < started; i++) this.tone(held);
    if (held.strum.total) this.pending.add(note);
  }

  /** The next tone of a held chord starts (key_chord_tone). */
  private tone(h: Held): void {
    const x = h.notes[h.started++];
    const ht = this.ht();
    if (this.settings.chord.chrd === CH_OFF) this.ctx.harmony.observe(this.ctx.index, x);
    ht.held[x >> 5] |= 1 << (x & 31);
    if (this.arp.p.mode) this.arp.add(x);
    else this.synth().noteOn(x, h.vel);
    this.onTone?.(x, h.vel, true);
  }

  private release(h: Held): void {
    const ht = this.ht();
    for (let i = 0; i < h.started; i++) {
      const x = h.notes[i];
      ht.held[x >> 5] &= ~(1 << (x & 31));
      this.arp.remove(x);
      this.synth().noteOff(x);
      this.onTone?.(x, 0, false);
    }
    h.started = 0;
    h.strum.total = 0;
  }

  noteOff(note: number): void {
    const h = this.chords.get(note);
    this.chords.delete(note);
    this.pending.delete(note);
    if (h) this.release(h);
    else { this.arp.remove(note); this.synth().noteOff(note); }
  }

  allOff(): void {
    this.chords.clear();
    this.pending.clear();
    const ht = this.ht();
    ht.held.fill(0); ht.nheld = 0;
    this.ctx.harmony.forget(this.ctx.index);
    this.arp.held = [];
    this.arp.stopNotes();
    this.synth().allOff();
  }

  /** Advances the strum and the arpeggiator by n samples at a tempo whose quarter note is `quarter` samples (gateN: real time for its gate). */
  tick(n: number, quarter: number, gateN = n): void {
    this.quarter = quarter;
    if (this.pending.size) this.strumTick(n);
    if (this.arp.p.mode || this.arp.note) this.arp.step(n, quarter, gateN);
    this.ht().nheld = this.arp.held.length;
  }

  private strumTick(n: number): void {
    for (const note of [...this.pending]) {
      const h = this.chords.get(note);
      if (!h || !h.strum.total) { this.pending.delete(note); continue; }
      this.ctx.harmony.strumDue(h.strum, h.started, n, this.quarter);
      while (h.started < h.strum.total && !this.ctx.harmony.strumDue(h.strum, h.started, 0, this.quarter)) this.tone(h);
      if (h.started === h.strum.total) this.pending.delete(note);
    }
  }

  /** The arpeggiator or an arp note is running, or a chord is still sweeping (the input needs ticking). */
  get active(): boolean { return !!(this.arp.p.mode || this.arp.note || this.pending.size); }

  /** The arp's rate (a note value): the external clock's grid converts its units at this division. */
  arpRate(): number { return this.arp.p.rate; }

  /** The tempo changed under an external clock. */
  rescale(oldBeat: number, newBeat: number, grid: ClockGrid): void {
    this.arp.rescale(oldBeat, newBeat, (v, np, op) => grid.scalePhase(v, np, op), clockScale, clockPeriod);
  }

  /** A fresh start: the arp's first note fires with the first pulse. */
  firstPulse(quarter: number): void {
    if (this.arp.pos === 0xfffffff) this.arp.step(0, quarter, 0);
  }
}
