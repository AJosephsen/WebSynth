import { engineById } from "../engines/registry";
import { Preset } from "../engines/presets";
import { EnginePoly } from "./enginesynth";
import { PolySynth } from "./poly";
import { DrumSynth } from "../drum/drumsynth";
import type { ModSetup } from "../mod/setup";

/** Anything the sequencer and the live keyboard can play. */
export interface Synth {
  gain: number;
  readonly activeVoices: number;
  noteOn(note: number, velocity?: number): void;
  noteOff(note: number): void;
  allOff(): void;
  /** Adds `n` samples to out starting at `start`. */
  render(out: Float32Array, start: number, n: number, side?: Float32Array): void;
  /** SPREAD is on: the voices are split left / right and render() also fills `side` (left minus right). */
  /** The voice mode (0 POLY, 1 MONO, 2 LEGATO, 3 UNISON); chord keys play a chord in POLY only. */
  readonly voiceMode?: number;
  /** The part's keys are a kit (no chords). */
  readonly keyKit?: boolean;
  /** A drum kit's MPC pad map: the GM note of pad 0..15 (QNT MPC, drum_mpc_note). */
  mpcNote?(pad: number): number;
  /** The part's scale for microtonal pitch (engine instruments; null: 12-tone). */
  setScale?(km: import("./keymap").KeyMapParams | null): void;
  readonly spreadActive?: boolean;
  /** SPRD, 0..127. */
  readonly spreadAmount?: number;
  /** The LFO and modulation matrix (engine instruments only). */
  setMod?(m: ModSetup | undefined): void;
  /** The track's mix values the matrix modulates from (pan, dist and the sends). */
  setMix?(m: { pan: number; dist: number; chorus: number; delay: number; reverb: number }): void;
  /** The mix values of the block last rendered, modulated. Undefined: the matrix does not touch them. */
  readonly mixMod?: { pan: number; dist: number; chorus: number; delay: number; reverb: number };
  setBpm?(bpm: number): void;
  /** A MIDI-learned controller sets a track parameter. */
  learnParam?(id: number, v: number): void;
  /** The pitch wheel, in 1/256 semitone. */
  setBend?(q8: number): void;
  /** Parameters the sequencer's locks and automation can move. */
  readonly paramStore?: import("../seq/motion").ParamStore;
  /** A step's slide: the next legato note glides. */
  setSlide?(on: boolean): void;
  /** A MIDI controller: status 0xB0 (CC1 mod wheel, CC11 expression, CC121 reset) or 0xD0 (aftertouch). */
  midi?(status: number, d1: number, d2: number): void;
  /** TIME: how many samples a step of this note plays late (0: on time). */
  stepDelay?(note: number, vel: number, period: number): number;
}

/** The voice-mode settings of an engine part (Felucca's VOICE pages). */
export interface VoiceParams {
  voice: number; // 0 POLY, 1 MONO, 2 LEGATO, 3 UNISON
  glide: number; // 0..127
  glmode: number; // 0 RATE, 1 TIME
  prio: number; // 0 LAST, 1 LOW, 2 HIGH
  alloc: number; // 0 ROTATE, 1 REUSE
  detune: number; // 0..127
  spread: number; // 0..127
}

/** A playable sound, as it travels between the page and the worklet. */
export type Instrument =
  | { kind: "fm6"; patch: Uint8Array }
  | { kind: "drum"; params: number[]; fx?: number[] }
  | { kind: "engine"; engine: string; params: number[]; env: number[]; fenv: number; mono: boolean; ftype?: number; fx?: number[]; vp?: VoiceParams };

export function instrumentFromPreset(engine: string, p: Preset): Instrument {
  return { kind: "engine", engine, params: [...p.e], env: [...p.env], fenv: p.fenv, mono: !!p.mono, fx: [...p.fx] };
}

export function makeSynth(inst: Instrument, voices = 8): Synth {
  if (inst.kind === "fm6") return new PolySynth(inst.patch, voices);
  if (inst.kind === "drum") return new DrumSynth(inst.params);
  const e = engineById(inst.engine);
  if (!e) throw new Error(`unknown engine ${inst.engine}`);
  return new EnginePoly(e.def, inst, voices);
}
