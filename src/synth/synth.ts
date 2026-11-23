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
  render(out: Float32Array, start: number, n: number): void;
  /** The LFO and modulation matrix (engine instruments only). */
  setMod?(m: ModSetup | undefined): void;
  /** The track's mix values the matrix modulates from (pan, dist and the sends). */
  setMix?(m: { pan: number; dist: number; chorus: number; delay: number; reverb: number }): void;
  /** The mix values of the block last rendered, modulated. Undefined: the matrix does not touch them. */
  readonly mixMod?: { pan: number; dist: number; chorus: number; delay: number; reverb: number };
  setBpm?(bpm: number): void;
  /** A MIDI controller: status 0xB0 (CC1 mod wheel, CC11 expression, CC121 reset) or 0xD0 (aftertouch). */
  midi?(status: number, d1: number, d2: number): void;
  /** TIME: how many samples a step of this note plays late (0: on time). */
  stepDelay?(note: number, vel: number, period: number): number;
}

/** A playable sound, as it travels between the page and the worklet. */
export type Instrument =
  | { kind: "fm6"; patch: Uint8Array }
  | { kind: "drum"; params: number[]; fx?: number[] }
  | { kind: "engine"; engine: string; params: number[]; env: number[]; fenv: number; mono: boolean; ftype?: number; fx?: number[] };

export function instrumentFromPreset(engine: string, p: Preset): Instrument {
  return { kind: "engine", engine, params: [...p.e], env: [...p.env], fenv: p.fenv, mono: !!p.mono, fx: [...p.fx] };
}

export function makeSynth(inst: Instrument, voices = 8): Synth {
  if (inst.kind === "fm6") return new PolySynth(inst.patch, voices);
  if (inst.kind === "drum") return new DrumSynth(inst.params);
  const e = engineById(inst.engine);
  if (!e) throw new Error(`unknown engine ${inst.engine}`);
  return new EnginePoly(e.def, inst, inst.mono ? 1 : voices);
}
