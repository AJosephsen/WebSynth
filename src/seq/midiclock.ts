// Following an external MIDI clock (Felucca's midi_clock.c, GPL-3.0-only; adapted there from contributions by ChanceTheMaker and
// keremimo). Pulses (24 to the quarter note) carry timestamps; the audio side advances in fixed musical units between them,
// never across a pulse before it arrives, so USB jitter stays out of the render loop. Sequencers and arps convert the units
// to samples with a fractional carry. See NOTICE.
export const CLOCK_GRID = 24000; // fixed units per quarter, divisible by every DIV denominator
const DIV_DEN = [1, 2, 4, 8, 3, 6];

/** A step division (note value, ARP_RATES order) as a fraction of a quarter note: the samples of one, from a quarter's. */
export function clockPeriod(quarter: number, div: number): number {
  return div < 6 ? Math.floor(quarter / DIV_DEN[div]) : div < 10 ? (quarter << (div - 5)) >>> 0 : Math.floor(quarter / DIV_DEN[div % 6]);
}

/** The fractional remainder of a unit-to-sample conversion, kept so no floor() error piles up. */
export class ClockGrid {
  remainder = 0;
  /** n units to samples at `quarter` samples a quarter, for step division div (0 for a plain quarter). */
  advance(n: number, quarter: number, div: number): number {
    if (div < 6) quarter = Math.floor(quarter / DIV_DEN[div]) * DIV_DEN[div];
    const numerator = n * quarter + this.remainder;
    this.remainder = numerator % CLOCK_GRID;
    return Math.floor(numerator / CLOCK_GRID);
  }
  /** value scaled from one period to another, keeping the fractional phase (midi_clock_scale_phase). */
  scalePhase(value: number, newPeriod: number, oldPeriod: number): number {
    let phase = BigInt(value) * BigInt(CLOCK_GRID) + BigInt(this.remainder);
    phase = (phase * BigInt(newPeriod) + BigInt(Math.floor(oldPeriod / 2))) / BigInt(oldPeriod);
    this.remainder = Number(phase % BigInt(CLOCK_GRID));
    return Number(phase / BigInt(CLOCK_GRID));
  }
}

export const clockScale = (value: number, newPeriod: number, oldPeriod: number): number =>
  Math.floor((value * newPeriod + Math.floor(oldPeriod / 2)) / oldPeriod);

export type ClockTransport = "start" | "continue" | "stop";

export class MidiClock {
  pos = 0; rendered = 0; lastMs = 0; startMs = 0; intervalMs = 0;
  pulseUnits = 0; interpQ8 = 0; tempoMs = 0;
  havePulse = false; tempoValid = false; tempoN = 0;
  /** The measured quarter note in samples (0 until a tempo is known). */
  beatSamples = 0;
  /** The measured tempo, BPM. */
  bpm = 0;

  reset(): void {
    this.pos = this.rendered = this.lastMs = this.startMs = this.intervalMs = 0;
    this.pulseUnits = this.interpQ8 = this.tempoMs = 0;
    this.havePulse = this.tempoValid = false;
    this.tempoN = 0;
    this.beatSamples = 0;
    this.bpm = 0;
  }

  /** Start (0xFA: step zero), Continue (0xFB: preserve the step), Stop (0xFC). */
  transport(status: number, ms: number): ClockTransport | null {
    if (status === 0xfa) {
      this.pos = this.rendered = 0;
      this.havePulse = this.tempoValid = false;
      this.intervalMs = 0;
      this.startMs = ms;
      return "start";
    }
    if (status === 0xfb) {
      this.pos = this.rendered;
      this.havePulse = this.tempoValid = false;
      this.intervalMs = 0;
      this.startMs = ms;
      return "continue";
    }
    if (status === 0xfc) return "stop";
    return null;
  }

  /**
   * One clock pulse at time ms. onTempo is called with the old and new quarter in samples when the tempo changed while the
   * song plays (the caller rescales the running phases). beat: the current quarter in samples; sampleRate: the engine's.
   * playing: the song runs. firstPulse is called when a pulse enters a fresh start (the sequencers enter step 0 first).
   */
  pulse(ms: number, beat: number, sampleRate: number, playing: boolean, onTempo: (oldBeat: number, newBeat: number) => void, firstPulse: () => void): void {
    if (!this.tempoValid) {
      this.tempoValid = true;
      this.tempoMs = ms;
      this.tempoN = 0;
    } else if (++this.tempoN === 6) {
      const dt = ms - this.tempoMs;
      this.tempoMs = ms;
      this.tempoN = 0;
      // six clocks are a quarter of a beat: reject gaps and corrupt bursts
      if (dt >= 62 && dt <= 375) {
        const newBeat = Math.floor((sampleRate * dt) / 250);
        if (playing && newBeat !== beat) onTempo(beat, newBeat);
        this.beatSamples = newBeat;
        this.bpm = Math.min(240, Math.max(40, Math.floor((15000 + Math.floor(dt / 2)) / dt)));
      }
    }
    if (playing) {
      if (!this.havePulse) firstPulse();
      if (this.havePulse) {
        const interval = ms - this.lastMs;
        if (interval >= 8 && interval <= 80) this.intervalMs = interval;
        this.pos += CLOCK_GRID / 24;
      }
      this.havePulse = true;
    }
    this.pulseUnits = CLOCK_GRID / 24;
    if (!this.intervalMs) this.intervalMs = Math.max(1, Math.floor((beat * 1000) / (sampleRate * 24)));
    this.interpQ8 = Math.floor((this.pulseUnits * 256) / this.intervalMs);
    this.lastMs = ms;
  }

  /** The musical units to render now: interpolated towards the next pulse, never across it. */
  advance(now: number): number {
    if (!this.havePulse) return 0;
    let elapsed = now - this.lastMs;
    if (elapsed > this.intervalMs) elapsed = this.intervalMs;
    let offset = (elapsed * this.interpQ8) >> 8;
    if (offset >= this.pulseUnits) offset = this.pulseUnits - 1;
    const target = this.pos + offset;
    let n = target - this.rendered > 0 ? target - this.rendered : 0;
    if (n > CLOCK_GRID / 2) n = CLOCK_GRID / 2;
    this.rendered += n;
    return n;
  }
}
