import { engineById } from "../engines/registry";
import { Preset } from "../engines/presets";
import { EnginePoly } from "./enginesynth";
import { PolySynth } from "./poly";

/** Anything the sequencer and the live keyboard can play. */
export interface Synth {
  gain: number;
  readonly activeVoices: number;
  noteOn(note: number, velocity?: number): void;
  noteOff(note: number): void;
  allOff(): void;
  /** Adds `n` samples to out starting at `start`. */
  render(out: Float32Array, start: number, n: number): void;
}

/** A playable sound, as it travels between the page and the worklet. */
export type Instrument =
  | { kind: "fm6"; patch: Uint8Array }
  | { kind: "engine"; engine: string; params: number[]; env: number[]; fenv: number; mono: boolean; ftype?: number };

export function instrumentFromPreset(engine: string, p: Preset): Instrument {
  return { kind: "engine", engine, params: [...p.e], env: [...p.env], fenv: p.fenv, mono: !!p.mono };
}

export function makeSynth(inst: Instrument, voices = 8): Synth {
  if (inst.kind === "fm6") return new PolySynth(inst.patch, voices);
  const e = engineById(inst.engine);
  if (!e) throw new Error(`unknown engine ${inst.engine}`);
  return new EnginePoly(e.def, inst, inst.mono ? 1 : voices);
}
