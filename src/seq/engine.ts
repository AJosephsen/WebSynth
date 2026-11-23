import { clamp, mulq15 } from "../engines/dsp";
import { CTL } from "../engines/types";
import { Dist, FxBus, FxSettings, Master } from "../fx/fx";
import { Insert } from "../fx/insert";
import { Perform } from "../fx/perform";
import { NoteInput } from "../synth/noteinput";
import type { ModSetup } from "../mod/setup";
import { LEVEL_Q12 } from "../engines/felucca-tables";
import { Instrument, makeSynth, Synth } from "../synth/synth";
import { MAX_STEPS, MixSetup, Pattern, Song, Step, TRACKS, defaultMix } from "./song";
import { SeqStep, ST_NOTE, ST_REST, ST_TIE, TrackSeq } from "./trackseq";

export interface EngineTrack {
  synth: Synth;
  mute: boolean;
}

/** The live keyboard's place in the mix. */
const LIVE_MIX: MixSetup = { ...defaultMix(), reverb: 25 };

/**
 * Sample-accurate pattern/song sequencer plus the synths it plays, mixed through Felucca's effects (per-track
 * distortion, level and pan, chorus / delay / reverb sends, master limiter). Steps are 16th notes.
 * "pattern" mode loops one pattern; "song" mode follows the arrangement (the pattern sequencer).
 * The same code runs in the AudioWorklet and offline (for the snippets). Audio is produced in blocks of CTL (32)
 * samples and handed out through a small FIFO, so any buffer size works.
 */
export class Engine {
  tracks: EngineTrack[] = [];
  live: Synth;
  liveMix: MixSetup = { ...LIVE_MIX };
  /** The LFO and matrix of the live keyboard's synth. */
  liveMod: ModSetup | undefined;
  song: Song;
  mode: "pattern" | "song" = "song";
  patternIndex = 0; // the pattern that loops in pattern mode
  /** Master volume, Q12 (4096 = 1.0). */
  masterQ12 = 3072;
  playing = false;
  stepIndex = 0; // steps entered by track 1 since play()
  arrPos = 0;
  /** Called when track 1 enters a step (pattern index, step, arrangement position). */
  onStep?: (pattern: number, step: number, arrPos: number) => void;
  /** Called when any track enters a step. */
  onTrackStep?: (track: number, pattern: number, step: number, arrPos: number) => void;
  /** One step sequencer per track (polymeter, ties, slides, ratchets, nudge, chances). */
  readonly seqs: TrackSeq[];
  private patPos = 0;
  private justStarted = false;
  // effects
  private bus = new FxBus();
  private master = new Master();
  private dists: Dist[] = [];
  private inserts: Insert[] = [];
  /** The FX hold layer: throws, mutes (see fx/perform.ts). */
  readonly perform = new Perform();
  /** The live keyboard's input: chord keys and the arpeggiator. */
  readonly liveInput = new NoteInput(() => this.live);
  private fxs: FxSettings;
  // output FIFO
  private fifoL = new Float32Array(CTL);
  private fifoR = new Float32Array(CTL);
  private fifoPos = CTL;
  // block scratch
  private tbuf: Float32Array[] = [];
  private sidebuf: Float32Array[] = [];
  private sideI = new Int32Array(CTL);
  private ibuf = new Int32Array(CTL);
  private sendC = new Int32Array(CTL);
  private sendD = new Int32Array(CTL);
  private sendR = new Int32Array(CTL);
  private wet = new Int32Array(CTL);
  private mixL = new Int32Array(CTL);
  private mixR = new Int32Array(CTL);

  constructor(private readonly sampleRate: number, live: Synth, song: Song) {
    this.live = live;
    this.song = song;
    this.fxs = this.makeFx(song);
    this.seqs = Array.from({ length: TRACKS }, (_, i) => this.makeSeq(i));
    this.applyTracks();
  }

  get bpm(): number { return this.song.bpm; }

  private makeFx(song: Song): FxSettings {
    return { bpm: song.bpm, ...song.fx };
  }

  addTrack(synth: Synth): EngineTrack {
    const t = { synth, mute: false };
    this.tracks.push(t);
    this.applyTracks();
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
    this.applyTracks();
  }

  /** Replaces the song while it plays; the position stays valid. */
  setSong(song: Song): void {
    this.song = song;
    this.fxs = this.makeFx(song);
    this.applyTracks();
    this.patternIndex = Math.min(this.patternIndex, song.patterns.length - 1);
    this.arrPos = Math.min(this.arrPos, song.arrangement.length - 1);
    this.tracks.forEach((t, i) => (t.mute = !!song.tracks[i]?.mute));
    this.applyPattern(false, 0);
  }

  /** Hands every track's synth its mix, modulation setup and the tempo. */
  private applyTracks(): void {
    this.tracks.forEach((t, i) => {
      const s = this.song.tracks[i];
      t.synth.setBpm?.(this.song.bpm);
      if (s) { t.synth.setMix?.(s); t.synth.setMod?.(s.mod); }
    });
    this.live.setMix?.(this.liveMix);
    this.live.setMod?.(this.liveMod);
    this.live.setBpm?.(this.song.bpm);
  }

  /** A live controller (mod wheel, aftertouch, expression) for one track, or the keyboard (track -1). */
  midi(track: number, status: number, d1: number, d2: number): void {
    (track < 0 ? this.live : this.tracks[track]?.synth)?.midi?.(status, d1, d2);
  }

  private currentPatternIndex(): number {
    return this.mode === "song" ? this.song.arrangement[this.arrPos] ?? 0 : this.patternIndex;
  }

  private currentPattern(): Pattern {
    return this.song.patterns[this.currentPatternIndex()] ?? this.song.patterns[0];
  }

  private makeSeq(i: number): TrackSeq {
    const seq = new TrackSeq({
      on: (n, v) => { const t = this.tracks[i]; if (t && !t.mute) t.synth.noteOn(n, v); },
      off: (n) => this.tracks[i]?.synth.noteOff(n),
      slide: (on) => this.tracks[i]?.synth.setSlide?.(on),
    });
    seq.timeHook = (note, vel, period) => this.tracks[i]?.synth.stepDelay?.(note, vel, period) ?? 0;
    seq.onStep = (idx) => {
      this.onTrackStep?.(i, this.currentPatternIndex(), idx, this.arrPos);
      if (i === 0) { this.onStep?.(this.currentPatternIndex(), idx, this.arrPos); this.stepIndex++; }
    };
    return seq;
  }

  /** Hands the current pattern's steps and the tracks' step timing to the sequencers; top: a new pattern begins, carry samples in. */
  private applyPattern(top: boolean, carry: number): void {
    const pat = this.currentPattern();
    const gswing = Math.min(100, Math.round(this.song.swing * 250));
    this.seqs.forEach((seq, i) => {
      const ts = this.song.tracks[i];
      seq.steps = (pat.steps[i] ?? []).map(toSeqStep);
      seq.p = {
        len: pat.lens?.[i] ?? Math.min(pat.length, MAX_STEPS),
        div: ts?.seq?.div ?? 2, swing: ts?.seq?.swing ?? 0, gate: ts?.seq?.gate ?? 115, quantize: ts?.seq?.quantize ?? 1,
      };
      seq.globalSwing = gswing;
      if (top) seq.top(carry);
    });
  }

  play(): void {
    this.playing = true;
    this.stepIndex = 0;
    this.arrPos = 0;
    this.patPos = 0;
    this.justStarted = true;
    this.applyPattern(false, 0);
    for (const s of this.seqs) s.start();
    this.perform.start();
  }

  stop(): void {
    this.playing = false;
    for (const s of this.seqs) s.stop();
    for (const t of this.tracks) t.synth.allOff();
  }

  /** The sequencers' block: the pattern clock (a new pattern when the longest track has played through), then every track. */
  private advanceSequencers(): void {
    if (!this.playing) return;
    const quarter = Math.round((this.sampleRate * 60) / this.song.bpm);
    if (this.justStarted) this.justStarted = false;
    else this.patPos += CTL;
    let len = 0;
    for (const s of this.seqs) len = Math.max(len, s.patternSamples(quarter));
    if (len > 0 && this.patPos >= len) {
      const carry = this.patPos - len;
      this.patPos = carry;
      if (this.mode === "song") this.arrPos = (this.arrPos + 1) % this.song.arrangement.length;
      this.applyPattern(true, carry);
    }
    for (const s of this.seqs) s.tick(CTL, quarter);
  }

  /** Renders the synths of one CTL block into per-source float buffers (tracks, then the live keyboard). */
  private renderSources(): void {
    const sources = this.tracks.length + 1;
    while (this.tbuf.length < sources) { this.tbuf.push(new Float32Array(CTL)); this.sidebuf.push(new Float32Array(CTL)); }
    for (let i = 0; i < sources; i++) { this.tbuf[i].fill(0); this.sidebuf[i].fill(0); }
    this.advanceSequencers();
    this.live.render(this.tbuf[this.tracks.length], 0, CTL, this.sidebuf[this.tracks.length]);
    this.tracks.forEach((t, i) => t.synth.render(this.tbuf[i], 0, CTL, this.sidebuf[i]));
  }

  /** One source into the dry mix and the sends (fx.c mix_part). */
  private mixSource(src: Float32Array, index: number, base: MixSetup, synth?: Synth): void {
    if (synth?.spreadActive) { this.mixSpread(src, this.sidebuf[index], index, base, synth); return; }
    let m = base;
    const mm = synth?.mixMod;
    if (mm && (mm.pan !== base.pan || mm.dist !== base.dist || mm.chorus !== base.chorus || mm.delay !== base.delay || mm.reverb !== base.reverb)) {
      m = { ...base, pan: mm.pan, dist: mm.dist, chorus: mm.chorus, delay: mm.delay, reverb: mm.reverb };
    }
    const b = this.ibuf;
    for (let i = 0; i < CTL; i++) b[i] = Math.round(src[i] * 32768);
    (this.dists[index] ??= new Dist()).process(m.dist, b, CTL);
    const ins = (this.inserts[index] ??= new Insert());
    if (m.itype || ins.running) ins.process(m, b, CTL);
    const pf = this.perform;
    if (index < 4 && (pf.muteMask >> index) & 1) pf.mute(index, b, CTL);
    const lvl = LEVEL_Q12[m.level & 127];
    const pan = m.pan;
    const gl = 4096 - (pan > 0 ? pan * 64 : 0);
    const gr = 4096 + (pan < 0 ? pan * 64 : 0);
    const c = m.chorus * 258, d = m.delay * 258, r = m.reverb * 258;
    const mx = Math.max(c, d, r);
    const xmax = Math.floor(0x7fffffff / (mx | 1));
    for (let i = 0; i < CTL; i++) {
      const x = Math.imul(b[i] >> 2, lvl) >> 10;
      const xs = clamp(x, -xmax, xmax);
      if (c) this.sendC[i] += mulq15(xs, c);
      if (d) this.sendD[i] += mulq15(xs, d);
      if (r) this.sendR[i] += mulq15(xs, r);
      this.mixL[i] += Math.imul(x, gl) >> 12;
      this.mixR[i] += Math.imul(x, gr) >> 12;
    }
    if (pf.thr) pf.throwSend(m.level, m.reverb, m.delay, b, this.sendD, this.sendR, CTL);
  }

  /** SPREAD (fx.c mix_spread): the voices start left and right of PAN in turn, at PAN -/+ SPRD / 2. b is every voice (mono), d left minus right. */
  private mixSpread(src: Float32Array, side: Float32Array, index: number, base: MixSetup, synth: Synth): void {
    let m = base;
    const mm = synth.mixMod;
    if (mm) m = { ...base, pan: mm.pan, dist: mm.dist, chorus: mm.chorus, delay: mm.delay, reverb: mm.reverb };
    const b = this.ibuf, d = this.sideI;
    for (let i = 0; i < CTL; i++) { b[i] = Math.round(src[i] * 32768); d[i] = Math.round(side[i] * 32768); }
    (this.dists[index] ??= new Dist()).process(m.dist, b, CTL);
    const ins = (this.inserts[index] ??= new Insert());
    if (m.itype || ins.running) ins.process(m, b, CTL);
    const pf = this.perform;
    if (index < 4 && (pf.muteMask >> index) & 1) pf.muteSd(index, b, d, CTL);
    const lvl = LEVEL_Q12[m.level & 127], pan = m.pan, s = ((synth.spreadAmount ?? 0) + 1) >> 1;
    const pa = clamp(pan - s, -64, 63), pb = clamp(pan + s, -64, 63);
    const gla = 4096 - (pa > 0 ? pa * 64 : 0), gra = 4096 + (pa < 0 ? pa * 64 : 0);
    const glb = 4096 - (pb > 0 ? pb * 64 : 0), grb = 4096 + (pb < 0 ? pb * 64 : 0);
    const glm = (gla + glb) >> 1, grm = (gra + grb) >> 1, gld = (gla - glb) >> 1, grd = (gra - grb) >> 1;
    const c = m.chorus * 258, dl = m.delay * 258, r = m.reverb * 258;
    const mx = Math.max(c, dl, r);
    const xmax = Math.floor(0x7fffffff / (mx | 1));
    for (let i = 0; i < CTL; i++) {
      const x = Math.imul(b[i] >> 2, lvl) >> 10, y = Math.imul(d[i] >> 2, lvl) >> 10;
      const xs = clamp(x, -xmax, xmax);
      if (c) this.sendC[i] += mulq15(xs, c);
      if (dl) this.sendD[i] += mulq15(xs, dl);
      if (r) this.sendR[i] += mulq15(xs, r);
      this.mixL[i] += (Math.imul(x, glm) >> 12) + (Math.imul(y, gld) >> 12);
      this.mixR[i] += (Math.imul(x, grm) >> 12) + (Math.imul(y, grd) >> 12);
    }
    if (pf.thr) pf.throwSend(m.level, m.reverb, m.delay, b, this.sendD, this.sendR, CTL);
  }

  private produceBlock(): void {
    this.liveInput.tick(CTL, Math.round((this.sampleRate * 60) / this.song.bpm));
    this.perform.bpm = this.song.bpm;
    this.perform.playing = this.playing;
    const perf = this.perform.begin(CTL);
    this.tracks.forEach((t, i) => { const s = this.song.tracks[i]; if (s) t.synth.setMix?.(s); });
    this.live.setMix?.(this.liveMix);
    this.renderSources();
    this.sendC.fill(0); this.sendD.fill(0); this.sendR.fill(0); this.mixL.fill(0); this.mixR.fill(0);
    this.tracks.forEach((t, i) => {
      const setup = this.song.tracks[i];
      this.mixSource(this.tbuf[i], i, setup ?? defaultMix(), t.synth);
    });
    this.mixSource(this.tbuf[this.tracks.length], this.tracks.length, this.liveMix, this.live);
    if (perf) this.perform.pre(this.mixL, this.mixR, this.sendD, this.sendR, CTL);
    this.bus.throwAmount = this.perform.ew1;
    this.bus.process(this.fxs, this.sendC, this.sendD, this.sendR, this.wet, CTL);
    if (this.bus.side) this.bus.sideMix(this.mixL, this.mixR, CTL);
    const mg = this.masterQ12;
    for (let i = 0; i < CTL; i++) {
      this.mixL[i] = Math.imul((this.mixL[i] + this.wet[i]) >> 2, mg) >> 10;
      this.mixR[i] = Math.imul((this.mixR[i] + this.wet[i]) >> 2, mg) >> 10;
    }
    if (perf) this.perform.block(this.mixL, this.mixR, CTL); // the FX layer between the master level and the limiter
    for (let i = 0; i < CTL; i++) {
      const [ol, or] = this.master.process(this.mixL[i], this.mixR[i]);
      this.fifoL[i] = ol / 32768;
      this.fifoR[i] = or / 32768;
    }
    this.fifoPos = 0;
  }

  /** Renders stereo audio (overwrites l and r). */
  renderStereo(l: Float32Array, r: Float32Array): void {
    for (let i = 0; i < l.length; i++) {
      if (this.fifoPos >= CTL) this.produceBlock();
      l[i] = this.fifoL[this.fifoPos];
      r[i] = this.fifoR[this.fifoPos];
      this.fifoPos++;
    }
  }

  /** Renders a mono mixdown ((L + R) / 2) into out, which must start silent. */
  render(out: Float32Array): void {
    const r = new Float32Array(out.length);
    this.renderStereo(out, r);
    for (let i = 0; i < out.length; i++) out[i] = (out[i] + r[i]) / 2;
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

/** A song step as the sequencer plays it. */
function toSeqStep(st: Step): SeqStep {
  if (!st) return { notes: [], time: ST_REST };
  return {
    notes: st.notes, time: st.tie ? ST_TIE : ST_NOTE, vel: st.vel ?? 100, gate: st.gate,
    accent: st.accent, slide: st.slide, ratchet: st.ratchet, nudge: st.nudge, probability: st.prob,
  };
}
