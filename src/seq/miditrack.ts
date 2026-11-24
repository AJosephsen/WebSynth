// The output of a MIDI-only track (Melodee's midi_track.c, GPL-3.0-only): the notes of its sequencer go out as MIDI note-ons and note-offs on the
// track's channel, apart from any audio voice. A retrigger finishes the previous strike first; a mute or a channel change releases what is held on the
// old channel (and the sustain pedal) before anything is sent on the new one. See NOTICE.
export class MidiTrackOut {
  private held = new Set<number>();
  private pedal = false;
  private channel = 0;
  /** The track's channel 1..16 and whether it is silenced (mute / solo). */
  settings = { channel: 1, blocked: false };

  constructor(private readonly emit: (bytes: number[]) => void) {}

  private ch(): number { return Math.min(16, Math.max(1, this.settings.channel)) - 1; }

  /** A mute or a channel change finishes the old channel first (midi_track_service). */
  private service(): void {
    if (this.settings.blocked || this.channel !== this.ch()) this.allOff();
  }

  allOff(): void {
    for (const n of this.held) this.emit([0x80 | this.channel, n, 0]);
    this.held.clear();
    if (this.pedal) { this.emit([0xb0 | this.channel, 64, 0]); this.pedal = false; }
  }

  noteOff(note: number): void {
    if (note > 127 || !this.held.has(note)) return;
    this.emit([0x80 | this.channel, note, 0]);
    this.held.delete(note);
  }

  noteOn(note: number, vel: number): void {
    if (note > 127 || this.settings.blocked) return;
    this.service();
    this.noteOff(note); // retrigger: finish the previous strike
    this.channel = this.ch();
    this.emit([0x90 | this.channel, note, vel & 127]);
    this.held.add(note);
  }

  /** A controller (status 0xB0.. with its two data bytes) on the track's channel; the sustain pedal is remembered for the release. */
  controller(status: number, d1: number, d2: number): void {
    if (this.settings.blocked) return;
    this.service();
    this.channel = this.ch();
    this.emit([(status & 0xf0) | this.channel, d1, d2]);
    if ((status & 0xf0) === 0xb0 && d1 === 64) this.pedal = d2 >= 64;
    if ((status & 0xf0) === 0xb0 && d1 === 121) this.pedal = false;
  }

  /** Called as the block runs: a mute or channel change releases the held notes at once. */
  tick(): void {
    if (this.held.size || this.pedal) this.service();
  }
}
