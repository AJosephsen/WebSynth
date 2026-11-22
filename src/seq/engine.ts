import { PolySynth } from "../synth/poly";

/** One step: a note or chord, with velocity and gate length (in steps). null = rest. */
export type Step = { notes: number[]; vel?: number; gate?: number } | null;

export interface Track {
  synth: PolySynth;
  steps: Step[];
  mute: boolean;
}

interface PendingOff {
  frames: number;
  track: Track;
  notes: number[];
}

/**
 * Sample-accurate step sequencer plus the synths it plays. Steps are 16th notes.
 * The same code runs in the AudioWorklet and offline (for the snippets).
 */
export class Engine {
  tracks: Track[] = [];
  live: PolySynth;
  bpm = 120;
  swing = 0; // 0..0.5, delays every second step
  master = 0.6; // pre-limiter gain; the output is soft-limited with tanh
  playing = false;
  stepIndex = 0;
  private framesToStep = 0;
  private pending: PendingOff[] = [];

  constructor(private readonly sampleRate: number, live: PolySynth) {
    this.live = live;
  }

  addTrack(synth: PolySynth, steps: Step[] = []): Track {
    const t: Track = { synth, steps, mute: false };
    this.tracks.push(t);
    return t;
  }

  play(): void {
    this.playing = true;
    this.stepIndex = 0;
    this.framesToStep = 0;
  }

  stop(): void {
    this.playing = false;
    this.pending = [];
    for (const t of this.tracks) t.synth.allOff();
  }

  private stepFrames(index: number): number {
    const base = (this.sampleRate * 60) / this.bpm / 4;
    return Math.round(base * (index % 2 === 0 ? 1 + this.swing : 1 - this.swing));
  }

  private fireStep(): void {
    for (const t of this.tracks) {
      if (t.mute || t.steps.length === 0) continue;
      const st = t.steps[this.stepIndex % t.steps.length];
      if (!st) continue;
      for (const n of st.notes) t.synth.noteOn(n, st.vel ?? 100);
      const frames = Math.max(1, Math.round(this.stepFrames(this.stepIndex) * (st.gate ?? 0.9)));
      this.pending.push({ frames, track: t, notes: st.notes });
    }
    this.framesToStep = this.stepFrames(this.stepIndex);
    this.stepIndex++;
  }

  /** Mixes `out.length` samples into out, which must start silent. */
  render(out: Float32Array): void {
    let pos = 0;
    while (pos < out.length) {
      if (this.playing && this.framesToStep <= 0) this.fireStep();
      let n = out.length - pos;
      if (this.playing) n = Math.min(n, this.framesToStep);
      for (const p of this.pending) n = Math.min(n, p.frames);
      n = Math.max(1, n);
      this.live.render(out, pos, n);
      for (const t of this.tracks) t.synth.render(out, pos, n);
      pos += n;
      if (this.playing) this.framesToStep -= n;
      for (const p of this.pending) p.frames -= n;
      for (const p of this.pending) if (p.frames <= 0) for (const note of p.notes) p.track.synth.noteOff(note);
      this.pending = this.pending.filter((p) => p.frames > 0);
    }
    for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i] * this.master);
  }
}
