import { clamp, mulq15 } from "../engines/dsp";
import { CTL } from "../engines/types";
import { Dist, FxBus, FxSettings, Master } from "../fx/fx";
import { Insert } from "../fx/insert";
import { Perform } from "../fx/perform";
import { Punch, punchNeedsRing } from "../fx/punch";
import { Slicer, SlicerSetting } from "../fx/slicer";
import { defaultInput, NoteInput } from "../synth/noteinput";
import { Harmony, newHarmonyTrack } from "../synth/harmony";
import { motionParams } from "./params";
import { engineById } from "../engines/registry";
import type { ModSetup } from "../mod/setup";
import { LEVEL_Q12 } from "../engines/felucca-tables";
import { Instrument, makeSynth, Synth } from "../synth/synth";
import { LANE_DEFAULT, LANE_SILENT, MAX_STEPS, MixSetup, Pattern, Song, Step, TRACKS, defaultMix } from "./song";
import { ClockGrid, MidiClock, clockPeriod, clockScale } from "./midiclock";
import { Motion } from "./motion";
import { SeqStep, ST_NOTE, ST_REST, ST_TIE, TrackSeq } from "./trackseq";

export interface EngineTrack {
  synth: Synth;
  mute: boolean;
}

const OFF_SLICER: SlicerSetting = { mode: 0, pat: 1, rate: 1, depth: 100 };

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
  /** Step automation and locks per track. */
  readonly motions: Motion[];
  private patPos = 0;
  private justStarted = false;
  // external MIDI clock (midi_clock.c)
  /** 0 the song's tempo, 1 a MIDI clock in. */
  clockMode = 0;
  readonly clock = new MidiClock();
  /** Audio time in whole ms, the timestamp of the clock pulses. */
  nowMs = 0;
  /** The clock stopped arriving while the song played (the song stopped). */
  clockLost = false;
  /** Called when the measured tempo changes. */
  onTempo?: (bpm: number) => void;
  private lastBpm = 0;
  private units = 0;
  private readonly seqGrids = Array.from({ length: 4 }, () => new ClockGrid());
  private readonly arpGrid = new ClockGrid();
  private readonly patGrid = new ClockGrid();
  // effects
  private bus = new FxBus();
  private master = new Master();
  private dists: Dist[] = [];
  private inserts: Insert[] = [];
  private slicers: Slicer[] = [];
  /** The FX hold layer: throws, mutes (see fx/perform.ts). */
  readonly perform = new Perform();
  /** The punch-in FX layer (27 master effects, see fx/punch.ts) and the transport phase it follows, in samples of the quarter. */
  readonly punchLayer = new Punch();
  private punchBeatPos = 0;
  private readonly punchGrid = new ClockGrid();
  /** The live keyboard's input: chord keys and the arpeggiator. */
  /** What the chord keys' AUTO harmony hears: the four tracks and the live keyboard (the last). */
  readonly harmony = new Harmony(Array.from({ length: TRACKS + 1 }, newHarmonyTrack), { solo: () => 0, beatSamples: () => this.quarter() });
  readonly liveInput = new NoteInput(() => this.live, { harmony: this.harmony, index: TRACKS });
  /** The tracks' note inputs (MIDI channels that play a track go through them). */
  readonly trackInputs: NoteInput[] = Array.from({ length: TRACKS }, (_, i) => new NoteInput(() => this.tracks[i].synth, { harmony: this.harmony, index: i }));
  private readonly trackArpGrids = Array.from({ length: TRACKS }, () => new ClockGrid());
  /** MIDI in: 0 every channel plays the live keyboard, 1 channels 1-4 play tracks 1-4. */
  midiRoute = 0;
  private readonly midiCh = Array.from({ length: 16 }, () => ({ pedal: false, held: new Set<number>(), semis: 2, cents: 0, rpnMsb: 127, rpnLsb: 127 }));
  /** MIDI learn: a controller set to a parameter of a track (-1: the live keyboard). */
  learnMap: { cc: number; track: number; param: number }[] = [];
  private learning: { track: number; param: number } | null = null;
  /** Called when a controller was learned. */
  onLearned?: (cc: number, track: number, param: number) => void;
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
    this.motions = Array.from({ length: TRACKS }, (_, i) => new Motion(() => this.tracks[i]?.synth.paramStore));
    this.seqs = Array.from({ length: TRACKS }, (_, i) => this.makeSeq(i));
    this.applyTracks();
  }

  get bpm(): number { return this.clockMode && this.clock.bpm ? this.clock.bpm : this.song.bpm; }

  /** Samples in a quarter note: the measured one while an external clock runs. */
  private quarter(): number {
    return this.clockMode && this.clock.beatSamples ? this.clock.beatSamples : Math.round((this.sampleRate * 60) / this.song.bpm);
  }

  /** Hold the punch effect fx (0..26) on the master mix; -1 releases it (the key of a pad). */
  punch(fx: number): void { this.punchLayer.hold(fx); }

  /** The song's punch request: the effect fx (-1 none), restarted by every call that names one (a new event in the song). */
  punchSong(fx: number): void {
    const p = this.punchLayer;
    p.songReq = fx >= 0 && fx < 27 ? fx : -1;
    p.songBuffered = p.songReq >= 0 && punchNeedsRing(p.songReq);
    if (p.songReq >= 0) p.songGate++;
  }

  /** Follow the song's tempo (0) or a MIDI clock in (1). */
  setClockMode(mode: number): void {
    if (mode === this.clockMode) return;
    this.stop();
    this.clock.reset();
    this.clockMode = mode;
    this.clockLost = false;
  }

  /** A MIDI clock pulse (0xF8) arrived. */
  clockPulse(): void {
    if (!this.clockMode) return;
    const ms = Math.floor(this.nowMs);
    this.clock.pulse(ms, this.quarter(), this.sampleRate, this.playing, (oldBeat, newBeat) => {
      this.seqs.forEach((seq, i) => seq.rescale(oldBeat, newBeat, this.seqGrids[i]));
      this.liveInput.rescale(oldBeat, newBeat, this.arpGrid);
    }, () => {
      const q = this.quarter();
      for (const s of this.seqs) s.tick(0, q);
      this.liveInput.firstPulse(q);
    });
    if (this.clock.bpm && this.clock.bpm !== this.lastBpm) { this.lastBpm = this.clock.bpm; this.onTempo?.(this.clock.bpm); }
  }

  /** A MIDI transport message (0xFA start, 0xFB continue, 0xFC stop) arrived. */
  clockTransport(status: number): void {
    if (!this.clockMode) return;
    const r = this.clock.transport(status, Math.floor(this.nowMs));
    if (r === "start") this.play();
    else if (r === "continue") {
      if (!this.playing) for (const m of this.motions) m.begin();
      this.playing = true;
      for (const s of this.seqs) s.playing = true;
    } else if (r === "stop") this.stop();
  }

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
      this.trackInputs[i]?.set(s?.input ?? defaultInput());
    });
    this.live.setMix?.(this.liveMix);
    this.live.setMod?.(this.liveMod);
    this.live.setBpm?.(this.song.bpm);
  }

  /** The note input and synth a MIDI channel plays, null: the channel is not heard. */
  private channelTarget(ch: number): { input: NoteInput; synth: Synth; track: number } | null {
    if (this.midiRoute === 0) return { input: this.liveInput, synth: this.live, track: -1 };
    const t = this.tracks[ch];
    return ch < TRACKS && t ? { input: this.trackInputs[ch], synth: t.synth, track: ch } : null;
  }

  private pedalUp(ch: number, tg: { input: NoteInput }): void {
    const c = this.midiCh[ch];
    c.pedal = false;
    for (const n of c.held) tg.input.noteOff(n);
    c.held.clear();
  }

  /** The controller numbers MIDI learn leaves to the engine. */
  private static readonly RESERVED_CC = new Set([0, 1, 6, 11, 32, 38, 64, 98, 99, 100, 101, 120, 121, 123, 124, 125, 126, 127]);

  /** Arms MIDI learn: the next free controller is set to this parameter of the track (-1: the live keyboard). null disarms. */
  learn(track: number, param: number): void { this.learning = track < -1 ? null : { track, param }; }

  private applyCc(map: { track: number; param: number }, value: number): void {
    const synth = map.track < 0 ? this.live : this.tracks[map.track]?.synth;
    if (!synth?.learnParam) return;
    const range = this.paramRange(map.track, map.param);
    synth.learnParam(map.param, range.min + Math.round((value * (range.max - range.min)) / 127));
  }

  private paramRange(track: number, param: number): { min: number; max: number } {
    const synth = track < 0 ? this.live : this.tracks[track]?.synth;
    const defName = (synth as unknown as { engineName?: string })?.engineName;
    const list = motionParams(defName ? engineById(defName)?.def : undefined);
    const p = list.find((x) => x.id === param);
    return p ? { min: p.min, max: p.max } : { min: 0, max: 127 };
  }

  /** A MIDI channel message: notes, pedal, wheel, aftertouch, controllers (the shared channel controls of midi_control.c). */
  midiIn(status: number, d1: number, d2: number): void {
    const st = status & 0xf0, ch = status & 0x0f;
    const tg = this.channelTarget(ch);
    const c = this.midiCh[ch];
    if (st === 0xb0 && this.learning && !Engine.RESERVED_CC.has(d1)) {
      const l = this.learning;
      this.learnMap = this.learnMap.filter((m) => m.cc !== d1 && !(m.track === l.track && m.param === l.param));
      this.learnMap.push({ cc: d1, track: l.track, param: l.param });
      this.learning = null;
      this.onLearned?.(d1, l.track, l.param);
      return;
    }
    if (st === 0xb0) {
      const m = this.learnMap.find((x) => x.cc === d1);
      if (m && !Engine.RESERVED_CC.has(d1)) { this.applyCc(m, d2); return; }
    }
    if (!tg) return;
    const kit = !!tg.synth.keyKit;
    if (st === 0x90 && d2 > 0) {
      if (c.held.delete(d1)) tg.input.noteOff(d1);
      tg.input.noteOn(d1, d2, "midi");
    } else if (st === 0x80 || st === 0x90) {
      if (c.pedal && !kit) c.held.add(d1);
      else tg.input.noteOff(d1);
    } else if (st === 0xe0) {
      const v = (d1 | (d2 << 7)) - 8192;
      const range = Math.trunc(((c.semis * 100 + c.cents) * 256) / 100);
      if (!kit) tg.synth.setBend?.(Math.trunc((v * range) / (v < 0 ? 8192 : 8191)));
    } else if (st === 0xd0) {
      tg.synth.midi?.(0xd0, d1, 0);
    } else if (st === 0xb0) {
      switch (d1) {
        case 1: case 11: tg.synth.midi?.(0xb0, d1, d2); break;
        case 64: if (d2 >= 64) c.pedal = true; else this.pedalUp(ch, tg); break;
        case 100: c.rpnLsb = d2; break;
        case 101: c.rpnMsb = d2; break;
        case 6: if (c.rpnMsb === 0 && c.rpnLsb === 0) c.semis = Math.min(24, d2); break;
        case 38: if (c.rpnMsb === 0 && c.rpnLsb === 0) c.cents = Math.min(99, d2); break;
        case 121: // RESET ALL CONTROLLERS
          this.pedalUp(ch, tg);
          tg.synth.midi?.(0xb0, 121, 0);
          tg.synth.setBend?.(0);
          c.semis = 2; c.cents = 0; c.rpnMsb = c.rpnLsb = 127;
          break;
        case 120: case 123: // ALL SOUND OFF / ALL NOTES OFF
          this.pedalUp(ch, tg);
          tg.input.allOff();
          break;
        default: break;
      }
    }
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

  /** The pattern a track plays in the current section (a lane may name another one), undefined: the track is silent. */
  private lanePattern(track: number): Pattern | undefined {
    const lane = this.mode === "song" ? this.song.sections?.[this.arrPos]?.lanes?.[track] ?? LANE_DEFAULT : LANE_DEFAULT;
    if (lane === LANE_SILENT) return undefined;
    return lane >= 0 ? this.song.patterns[lane] ?? this.currentPattern() : this.currentPattern();
  }

  /** The section's clock track: the first one that is not silent. */
  private clockTrack(): number {
    for (let i = 0; i < TRACKS; i++) if (this.lanePattern(i)) return i;
    return 0;
  }

  private makeSeq(i: number): TrackSeq {
    const seq = new TrackSeq({
      on: (n, v) => { const t = this.tracks[i]; if (t && !t.mute) t.synth.noteOn(n, v); },
      off: (n) => this.tracks[i]?.synth.noteOff(n),
      slide: (on) => this.tracks[i]?.synth.setSlide?.(on),
    });
    seq.onPlay = (idx, played) => this.motions[i].step(idx, played);
    seq.timeHook = (note, vel, period) => this.tracks[i]?.synth.stepDelay?.(note, vel, period) ?? 0;
    seq.onStep = (idx) => {
      const pi = this.song.patterns.indexOf(this.lanePattern(i) ?? this.currentPattern());
      this.onTrackStep?.(i, pi, idx, this.arrPos);
      if (i === 0) { this.onStep?.(pi, idx, this.arrPos); this.stepIndex++; }
    };
    return seq;
  }

  /** Hands the current pattern's steps and the tracks' step timing to the sequencers; top: a new pattern begins, carry samples in. */
  private applyPattern(top: boolean, carry: number): void {
    const gswing = Math.min(100, Math.round(this.song.swing * 250));
    this.seqs.forEach((seq, i) => {
      const ts = this.song.tracks[i];
      const pat = this.lanePattern(i);
      if (pat) {
        seq.steps = (pat.steps[i] ?? []).map(toSeqStep);
        seq.p = {
          len: pat.lens?.[i] ?? Math.min(pat.length, MAX_STEPS),
          div: ts?.seq?.div ?? 2, swing: ts?.seq?.swing ?? 0, gate: ts?.seq?.gate ?? 115, quantize: ts?.seq?.quantize ?? 1,
        };
      } else { // a silent lane: a bar of nothing
        seq.steps = [];
        seq.p = { len: 16, div: 2, swing: 0, gate: 115, quantize: 1 };
      }
      seq.globalSwing = gswing;
      this.motions[i].events = (pat?.motion ?? []).filter((m) => m.track === i).map((m) => ({ step: m.step, param: m.param, value: m.value, lock: m.lock }));
      if (top) { seq.top(carry); this.motions[i].restore(); }
    });
  }

  play(): void {
    this.playing = true;
    this.stepIndex = 0;
    this.arrPos = 0;
    this.patPos = 0;
    this.justStarted = true;
    for (const g of this.seqGrids) g.remainder = 0;
    this.arpGrid.remainder = 0;
    this.patGrid.remainder = 0;
    if (this.clockMode) this.clock.transport(0xfa, Math.floor(this.nowMs));
    this.applyPattern(false, 0);
    for (const s of this.seqs) s.start();
    for (const m of this.motions) m.begin();
    for (const sl of this.slicers) sl.start();
    this.perform.start();
    this.punchBeatPos = 0;
    this.punchGrid.remainder = 0;
  }

  stop(): void {
    this.playing = false;
    this.punchLayer.hold(-1); // Stop ends a punch request (seq.c seq_stop)
    this.punchLayer.songReq = -1;
    this.punchLayer.songBuffered = false;
    for (const s of this.seqs) s.stop();
    for (const m of this.motions) m.end();
    for (const t of this.tracks) t.synth.allOff();
  }

  /** The musical units of this block: CTL samples at the song's tempo, or what an external clock has delivered (0 while stopped). */
  private blockUnits(): number {
    if (!this.clockMode) return CTL;
    if (!this.playing) return 0;
    const now = Math.floor(this.nowMs);
    const last = this.clock.havePulse ? this.clock.lastMs : this.clock.startMs;
    if (now - last > 500) { // the cable is gone: never leave a held note running
      this.stop();
      this.clock.tempoValid = false;
      this.clockLost = true;
      return 0;
    }
    return this.clock.advance(now);
  }

  /** The sequencers' block: the pattern clock (a new pattern when the clock track has played through), then every track. */
  private advanceSequencers(units: number): void {
    if (!this.playing) return;
    const quarter = this.quarter();
    const patN = this.clockMode ? this.patGrid.advance(units, quarter, 0) : CTL;
    if (this.justStarted) this.justStarted = false;
    else this.patPos += patN;
    const repeat = this.mode === "song" ? this.song.sections?.[this.arrPos]?.repeat ?? 1 : 1;
    const len = this.seqs[this.clockTrack()].patternSamples(quarter) * repeat;
    if (len > 0 && this.patPos >= len) {
      const carry = this.patPos - len;
      this.patPos = carry;
      if (this.mode === "song") this.arrPos = (this.arrPos + 1) % this.song.arrangement.length;
      this.applyPattern(true, carry);
    }
    this.seqs.forEach((s, i) => s.tick(this.clockMode ? this.seqGrids[i].advance(units, quarter, s.p.div) : CTL, quarter));
  }

  /** Renders the synths of one CTL block into per-source float buffers (tracks, then the live keyboard). */
  private renderSources(): void {
    const sources = this.tracks.length + 1;
    while (this.tbuf.length < sources) { this.tbuf.push(new Float32Array(CTL)); this.sidebuf.push(new Float32Array(CTL)); }
    for (let i = 0; i < sources; i++) { this.tbuf[i].fill(0); this.sidebuf[i].fill(0); }
    this.advanceSequencers(this.units);
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
    this.slice(index, base, b);
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


  /** The SLICER of a track (its step clock always runs). */
  private slice(index: number, base: MixSetup, b: Int32Array, sd?: Int32Array): void {
    if (index >= TRACKS) return;
    const sl = (this.slicers[index] ??= new Slicer());
    const ts = base as Partial<import("./song").TrackSetup>;
    const swing = Math.min(100, (this.song.tracks[index]?.seq?.swing ?? 0) + Math.min(100, Math.round(this.song.swing * 250)));
    sl.process(ts.slicer ?? OFF_SLICER, b, CTL, this.bpm, swing, sd);
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
    this.slice(index, base, b, d);
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
    this.units = this.blockUnits();
    const quarter = this.quarter();
    const bpm = this.bpm;
    this.fxs.bpm = bpm;
    this.seqs.forEach((q, i) => { const t = this.harmony.tracks[i]; t.seqNotes = q.soundingNotes; t.mute = !!this.song.tracks[i]?.mute; });
    this.harmony.tick(CTL);
    if (this.clockMode) {
      const an = this.arpGrid.advance(this.units, quarter, this.liveInput.arpRate());
      this.liveInput.tick(an, quarter, this.playing ? an : CTL);
    } else this.liveInput.tick(CTL, quarter, CTL);
    this.trackInputs.forEach((inp, i) => {
      if (!inp.active) return;
      if (this.clockMode) { const an = this.trackArpGrids[i].advance(this.units, quarter, inp.arpRate()); inp.tick(an, quarter, this.playing ? an : CTL); }
      else inp.tick(CTL, quarter, CTL);
    });
    for (const t of this.tracks) t.synth.setBpm?.(bpm);
    this.live.setBpm?.(bpm);
    this.perform.bpm = bpm;
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
    const pu = this.punchLayer; // punch-in FX: after the master level, before the limiter
    if (pu.active) { pu.beat = quarter; pu.playing = this.playing; pu.clock = this.punchBeatPos; pu.process(this.mixL, this.mixR, CTL); }
    if (this.playing) { // the transport phase within the quarter
      this.punchBeatPos += this.clockMode ? this.punchGrid.advance(this.units, quarter, 0) : CTL;
      while (this.punchBeatPos >= quarter) this.punchBeatPos -= quarter;
    }
    for (let i = 0; i < CTL; i++) {
      const [ol, or] = this.master.process(this.mixL[i], this.mixR[i]);
      this.fifoL[i] = ol / 32768;
      this.fifoR[i] = or / 32768;
    }
    this.nowMs += (CTL * 1000) / this.sampleRate;
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
