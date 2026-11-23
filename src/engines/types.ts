// The engine interface of Felucca-Engines (MIT) in TypeScript. See NOTICE.
export const FS = 44100;
export const CTL = 32; // samples per block
export const NVOICE = 8;

// track parameter indices
export const P_ATK = 0, P_REL = 1, P_FTYPE = 2, P_E0 = 3, P_E1 = 4, P_E2 = 5, P_E3 = 6, P_E4 = 7, P_E5 = 8, P_E6 = 9, P_E7 = 10, P_ROOT = 11, P_COUNT = 12;

/** Parameter display kinds (felucca_engine.h F_*). */
export const enum F { INT, PCT, BIPCT, TIME, LFOHZ, CUTOFF, DB, SEMI, ENUM, BPM, NOTE, ONOFF, OCT, STEPS }

export interface ParamDesc {
  label: string;
  fmt: F;
  min: number;
  max: number;
  def: number;
  names?: readonly string[];
  unit?: string;
}

export class EngVoice {
  note = 0; vel = 0; gate = 0; active = 0; stage = 0;
  env = 0; envOut = 0;
  pitch16 = 0; pitchCur = 0;
  fine = 0;
  ph = new Uint32Array(3);
  s = new Int32Array(8);
  age = 0;
}

/** Per-block modulation of a voice. */
export interface Vmod {
  inc: number; // uint32
  pitch16: number;
  amp0: number;
  amp1: number; // Q15 ramp over the block
  cutoff: number; // 0..127 << 8
  shape: number; // 0..127 << 8
  envq15: number;
  fine: number;
}

export class Track {
  p = new Int16Array(P_COUNT);
  v = Array.from({ length: NVOICE }, () => new EngVoice());
}

export interface EngineDef {
  name: string;
  pageTitle: [string, string];
  edit: ParamDesc[]; // P_E0..P_E7
  knob: number[];
  keep: number;
  /** Voices the engine can sound at once (PHYS keeps a state slot for 3). */
  poly?: number;
  noteOn(t: Track, v: EngVoice): void;
  render(t: Track, v: EngVoice, out: Int32Array, n: number, m: Vmod): void;
  /** Optional: the voice amplitude instead of the ADSR curve, once per control tick. */
  amp?(t: Track, v: EngVoice, adsr: number): number;
  /** Optional: a mode-dependent descriptor of EDIT k, else edit[k]. */
  desc?(t: Track, k: number): ParamDesc | undefined;
  /** Optional: once per block and part, before its voices. */
  block?(t: Track): void;
  /** Resets engine state that lives outside the voices (WHEEL). */
  reset?(): void;
}
