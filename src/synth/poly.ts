import { Fm6Voice } from "../fm6/note";

interface Slot {
  voice: Fm6Voice;
  note: number;
  held: boolean; // key still down
  age: number;
}

/** A polyphonic synth: N voices sharing one patch, oldest-released-first voice stealing. */
export class PolySynth {
  private slots: Slot[];
  private clock = 0;
  gain = 1;

  private readonly bendRef = { target: 0 };
  /** The pitch wheel, in 1/256 semitone. */
  setBend(q8: number): void { this.bendRef.target = q8; }

  constructor(patch: Uint8Array, voices = 8) {
    this.slots = Array.from({ length: voices }, () => { const voice = new Fm6Voice(patch); voice.bendRef = this.bendRef; return { voice, note: -1, held: false, age: 0 }; });
  }

  setPatch(patch: Uint8Array): void {
    for (const s of this.slots) s.voice.setPatch(patch);
  }

  get activeVoices(): number {
    return this.slots.filter((s) => s.voice.active).length;
  }

  noteOn(note: number, velocity = 100): void {
    // retrigger the same note on its own voice, else a free voice, else steal
    let s = this.slots.find((x) => x.note === note && x.voice.active);
    s ??= this.slots.find((x) => !x.voice.active);
    s ??= this.slots.filter((x) => !x.held).sort((a, b) => a.age - b.age)[0];
    s ??= [...this.slots].sort((a, b) => a.age - b.age)[0];
    s.note = note;
    s.held = true;
    s.age = ++this.clock;
    s.voice.noteOn(note, velocity);
  }

  noteOff(note: number): void {
    for (const s of this.slots) {
      if (s.note === note && s.held) {
        s.held = false;
        s.voice.noteOff();
      }
    }
  }

  allOff(): void {
    for (const s of this.slots) {
      s.held = false;
      s.voice.noteOff();
    }
  }

  /** Adds `n` samples to out starting at `start`. */
  render(out: Float32Array, start: number, n: number): void {
    for (const s of this.slots) {
      if (!s.voice.active) continue;
      for (let i = 0; i < n; i++) out[start + i] += s.voice.next() * this.gain;
    }
  }
}
