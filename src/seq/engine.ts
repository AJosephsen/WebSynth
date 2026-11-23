import { Instrument, makeSynth, Synth } from "../synth/synth";
import { MAX_STEPS, Pattern, Song, Step, TRACKS } from "./song";

interface PendingOff {
  frames: number;
  synth: Synth;
  notes: number[];
}

export interface EngineTrack {
  synth: Synth;
  mute: boolean;
}

/**
 * Sample-accurate pattern/song sequencer plus the synths it plays. Steps are 16th notes.
 * "pattern" mode loops one pattern; "song" mode follows the arrangement (the pattern sequencer).
 * The same code runs in the AudioWorklet and offline (for the snippets).
 */
export class Engine {
  tracks: EngineTrack[] = [];
  live: Synth;
  song: Song;
  mode: "pattern" | "song" = "song";
  patternIndex = 0; // the pattern that loops in pattern mode
  master = 0.6; // pre-limiter gain; the output is soft-limited with tanh
  playing = false;
  stepIndex = 0; // steps fired since play()
  stepInPattern = 0;
  arrPos = 0;
  /** Called when a step fires (pattern index, step, arrangement position). */
  onStep?: (pattern: number, step: number, arrPos: number) => void;
  private framesToStep = 0;
  private pending: PendingOff[] = [];

  constructor(private readonly sampleRate: number, live: Synth, song: Song) {
    this.live = live;
    this.song = song;
  }

  get bpm(): number { return this.song.bpm; }

  addTrack(synth: Synth): EngineTrack {
    const t = { synth, mute: false };
    this.tracks.push(t);
    return t;
  }

  /** Swaps the synth of a track (or the live synth, track -1) for a new instrument. */
  setInstrument(track: number, inst: Instrument): void {
    const old = track < 0 ? this.live : this.tracks[track]?.synth;
    if (!old) return;
    old.allOff();
    const s = makeSynth(inst, track < 0 ? 8 : 6);
    s.gain = old.gain;
    if (track < 0) this.live = s;
    else this.tracks[track].synth = s;
  }

  /** Replaces the song while it plays; the position stays valid. */
  setSong(song: Song): void {
    this.song = song;
    this.patternIndex = Math.min(this.patternIndex, song.patterns.length - 1);
    this.arrPos = Math.min(this.arrPos, song.arrangement.length - 1);
    const len = this.currentPattern().length;
    if (this.stepInPattern >= len) this.stepInPattern = 0;
    this.tracks.forEach((t, i) => (t.mute = !!song.tracks[i]?.mute));
  }

  private currentPatternIndex(): number {
    return this.mode === "song" ? this.song.arrangement[this.arrPos] ?? 0 : this.patternIndex;
  }

  private currentPattern(): Pattern {
    return this.song.patterns[this.currentPatternIndex()] ?? this.song.patterns[0];
  }

  play(): void {
    this.playing = true;
    this.stepIndex = 0;
    this.stepInPattern = 0;
    this.arrPos = 0;
    this.framesToStep = 0;
  }

  stop(): void {
    this.playing = false;
    this.pending = [];
    for (const t of this.tracks) t.synth.allOff();
  }

  private stepFrames(index: number): number {
    const base = (this.sampleRate * 60) / this.song.bpm / 4;
    return Math.round(base * (index % 2 === 0 ? 1 + this.song.swing : 1 - this.song.swing));
  }

  private fireStep(): void {
    const pat = this.currentPattern();
    const pi = this.currentPatternIndex();
    this.onStep?.(pi, this.stepInPattern, this.arrPos);
    for (let ti = 0; ti < Math.min(TRACKS, this.tracks.length); ti++) {
      const t = this.tracks[ti];
      const st: Step = pat.steps[ti]?.[this.stepInPattern] ?? null;
      if (t.mute || !st) continue;
      for (const n of st.notes) t.synth.noteOn(n, st.vel ?? 100);
      const frames = Math.max(1, Math.round(this.stepFrames(this.stepIndex) * (st.gate ?? 0.9)));
      this.pending.push({ frames, synth: t.synth, notes: st.notes });
    }
    this.framesToStep = this.stepFrames(this.stepIndex);
    this.stepIndex++;
    this.stepInPattern++;
    if (this.stepInPattern >= Math.min(pat.length, MAX_STEPS)) {
      this.stepInPattern = 0;
      if (this.mode === "song") this.arrPos = (this.arrPos + 1) % this.song.arrangement.length;
    }
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
      for (const p of this.pending) if (p.frames <= 0) for (const note of p.notes) p.synth.noteOff(note);
      this.pending = this.pending.filter((p) => p.frames > 0);
    }
    for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i] * this.master);
  }
}

/** Builds an engine for a song: one polyphonic synth per track. */
export function createEngine(sampleRate: number, song: Song, instrumentFor: (id: string) => Instrument, voices = 6): Engine {
  const e = new Engine(sampleRate, makeSynth(instrumentFor("TINE EP"), 8), song);
  song.tracks.forEach((t) => {
    const s = makeSynth(instrumentFor(t.patch), voices);
    s.gain = 0.7;
    e.addTrack(s).mute = t.mute;
  });
  return e;
}
