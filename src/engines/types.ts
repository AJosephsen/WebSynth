// The engine interface of Felucca-Engines (MIT) in TypeScript. See NOTICE.
export const FS = 44100;
export const CTL = 32; // samples per block
export const NVOICE = 8;

// track parameter indices
export const P_ATK = 0, P_REL = 1, P_FTYPE = 2, P_E0 = 3, P_E1 = 4, P_E2 = 5, P_E3 = 6, P_E4 = 7, P_E5 = 8, P_E6 = 9, P_E7 = 10, P_ROOT = 11;
// the track's mix, LFO and modulation matrix (Felucca's params; see src/mod/mod.ts)
export const P_PAN = 12, P_DIST = 13, P_CHOR = 14, P_DLY = 15, P_REV = 16,
  P_LRATE = 17, P_LWAVE = 18, P_LPHASE = 19, P_LFADE = 20, P_LD_PIT = 21, P_LD_FLT = 22, P_LD_SHP = 23, P_LD_AMP = 24,
  P_ED_FLT = 25, P_ED_PIT = 26, P_ED_SHP = 27, P_LSYNC = 28, P_LTRIG = 29, P_LPOL = 30,
  P_M1SRC = 31, // 4 slots of SRC, DST, AMT: P_M1SRC .. P_M1SRC + 11
  P_ATDST = 43, P_ATAMT = 44, P_COUNT = 45;

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
  mvel = 0; mrnd = 0; // the note's VEL and RAND for the matrix
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
  /** The index of the engine's edit descriptors used for the matrix's E1..E8 ranges (set by the owner). */
  edit: readonly ParamDesc[] = [];
  // the track LFO (voice.c) and the matrix's per-track sources (mod.c)
  lfoPh = 0; lfoVal = 0; lfoFade = 32767; lfoRnd = 0; lfoPrev = 0;
  mw = 0; at = 0; exOff = 0; mVel = 0; mKey = 0; mVi = 0; mRnd = 0; mEnv = 0;
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
  /** Plays recorded material: the voice still renders at a silent sustain. */
  sampled?: boolean;
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
