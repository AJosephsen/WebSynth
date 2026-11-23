// The note input of a part: chord keys (one key plays a chord) and the arpeggiator in front of a synth (seq.c input_on /
// input_off). A key's chord is remembered, so its release ends exactly the notes it started. See NOTICE.
import { Arp, ArpParams, defaultArp } from "./arp";
import { ClockGrid, clockPeriod, clockScale } from "../seq/midiclock";
import { chordMake } from "./chord";
import type { Synth } from "./synth";

export interface ChordSetting { chrd: number; voic: number; root: number; scale: number }
export interface InputSettings { arp: ArpParams; chord: ChordSetting }
export const defaultInput = (): InputSettings => ({ arp: defaultArp(), chord: { chrd: 0, voic: 0, root: 0, scale: 1 } });

export class NoteInput {
  settings: InputSettings = defaultInput();
  private readonly arp: Arp;
  private readonly chords = new Map<number, number[]>();

  constructor(private readonly synth: () => Synth) {
    this.arp = new Arp({ on: (n, v) => this.synth().noteOn(n, v), off: (n) => this.synth().noteOff(n) });
  }

  set(s: InputSettings): void {
    const wasOn = this.arp.p.mode !== 0;
    this.settings = s;
    this.arp.p = s.arp;
    if (wasOn && !s.arp.mode) this.arp.stopNotes();
  }

  noteOn(note: number, vel = 100): void {
    const s = this.synth();
    const c = this.settings.chord;
    const notes = chordMake({ ...c, voice: s.voiceMode ?? 0, kit: s.keyKit }, note).notes;
    this.chords.set(note, notes);
    for (const n of notes) {
      if (this.arp.p.mode) this.arp.add(n);
      else s.noteOn(n, vel);
    }
  }

  noteOff(note: number): void {
    const notes = this.chords.get(note) ?? [note];
    this.chords.delete(note);
    for (const n of notes) {
      this.arp.remove(n);
      this.synth().noteOff(n);
    }
  }

  allOff(): void {
    this.chords.clear();
    this.arp.held = [];
    this.arp.stopNotes();
    this.synth().allOff();
  }

  /** Advances the arpeggiator by n samples at a tempo whose quarter note is `quarter` samples (gateN: real time for its gate). */
  tick(n: number, quarter: number, gateN = n): void {
    if (this.arp.p.mode || this.arp.note) this.arp.step(n, quarter, gateN);
  }

  /** The arpeggiator or an arp note is running (the input needs ticking). */
  get active(): boolean { return !!(this.arp.p.mode || this.arp.note); }

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
