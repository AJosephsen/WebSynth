// Port of Felucca's FM6 lookup tables (tools/gen_tables.py, Felucca-Engines). See NOTICE.
export const FS = 44100;
export const CTL = 32; // samples per block
export const LG_N = 5;

/** 1025-point sine, Q15. */
export const SINE = Int16Array.from({ length: 1025 }, (_, i) => Math.round(32767 * Math.sin((2 * Math.PI * i) / 1024)));

/** (2^(i/1024) - 1) in Q30, 1025 points. */
export const EXP2 = Float64Array.from({ length: 1025 }, (_, i) => Math.round(2 ** 30 * (2 ** (i / 1024) - 1)));

/** 2^40 / FS: Q30 mantissa -> Q24 phase increment. */
export const FREQ_R = Math.round(2 ** 40 / FS);
