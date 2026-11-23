// Presets of the six engines, extracted from Felucca-Engines (MIT). See NOTICE.
export interface Preset { name: string; e: number[]; env: number[]; fenv: number; mono: number; fx: number[]; pat: number }
export const ANALOG_PRESETS: Preset[] = [
  { name: "SAW LEAD", e: [0, 12, 64, 0, 90, 30, 10, 64], env: [4, 70, 100, 50], fenv: 20, mono: 1, fx: [0, 10, 45, 30], pat: 4 },
  { name: "SOFT PAD", e: [0, 20, 64, 4, 60, 10, 0, 32], env: [80, 90, 110, 95], fenv: 10, mono: 0, fx: [0, 60, 20, 70], pat: 5 },
  { name: "SQR BASS", e: [1, 0, 0, 0, 50, 70, 40, 64], env: [0, 60, 40, 30], fenv: 30, mono: 1, fx: [5, 0, 10, 10], pat: 2 },
  { name: "PWM STR", e: [4, 8, 40, 0, 75, 20, 0, 48], env: [60, 80, 110, 85], fenv: 8, mono: 0, fx: [0, 50, 20, 60], pat: 5 },
  { name: "ACID", e: [0, 0, 0, 0, 50, 100, 25, 64], env: [0, 55, 20, 30], fenv: 48, mono: 1, fx: [20, 0, 45, 15], pat: 1 },
  { name: "SINE KEY", e: [3, 6, 50, 0, 127, 0, 0, 0], env: [2, 80, 30, 70], fenv: 0, mono: 0, fx: [0, 30, 25, 40], pat: 6 },
  { name: "RAVE", e: [4, 30, 64, 0, 85, 20, 30, 64], env: [20, 80, 110, 60], fenv: 10, mono: 1, fx: [30, 40, 30, 30], pat: 13 },
  { name: "SUB BASS", e: [3, 0, 0, 0, 40, 0, 20, 0], env: [0, 60, 100, 20], fenv: 0, mono: 1, fx: [0, 0, 0, 10], pat: 8 },
  { name: "PLUCK", e: [0, 8, 50, 0, 30, 40, 0, 64], env: [0, 88, 0, 60], fenv: 55, mono: 0, fx: [0, 20, 50, 30], pat: 3 },
  { name: "BRASS", e: [0, 10, 64, 0, 45, 20, 10, 64], env: [35, 70, 90, 45], fenv: 40, mono: 0, fx: [0, 20, 20, 40], pat: 6 },
  { name: "WIND", e: [0, 0, 0, 90, 30, 90, 0, 0], env: [60, 90, 60, 80], fenv: 50, mono: 0, fx: [0, 30, 30, 70], pat: 5 },
  { name: "STRINGS", e: [0, 25, 64, 0, 70, 10, 0, 32], env: [70, 90, 115, 90], fenv: 5, mono: 0, fx: [0, 60, 20, 70], pat: 5 },
];
export const LOFI_PRESETS: Preset[] = [
  { name: "PULSE LD", e: [0, 0, 32, 0, 0, 20, 0, 127], env: [0, 60, 90, 30], fenv: 0, mono: 1, fx: [0, 0, 40, 20], pat: 4 },
  { name: "WAVE BASS", e: [1, 1, 0, 0, 0, 0, 0, 90], env: [0, 50, 70, 20], fenv: 0, mono: 1, fx: [0, 0, 10, 0], pat: 2 },
  { name: "ARP 8BIT", e: [2, 0, 96, 0, 0, 0, 2, 110], env: [0, 60, 80, 40], fenv: 0, mono: 0, fx: [0, 0, 30, 20], pat: 13 },
  { name: "WAVE LEAD", e: [0, 4, 92, 0, 0, 18, 0, 110], env: [0, 70, 90, 30], fenv: 0, mono: 1, fx: [0, 0, 40, 25], pat: 3 },
  { name: "STEP LEAD", e: [4, 0, 40, 34, 0, 16, 0, 127], env: [0, 64, 127, 55], fenv: 0, mono: 1, fx: [0, 0, 40, 20], pat: 4 },
];
export const TRIO_PRESETS: Preset[] = [
  { name: "FAT BASS", e: [0, 0, -12, 9, 0, 62, 45, 64], env: [0, 62, 60, 25], fenv: 40, mono: 1, fx: [10, 0, 10, 10], pat: 2 },
  { name: "ARP LEAD", e: [2, 12, 0, 4, 0, 88, 25, 32], env: [0, 60, 90, 30], fenv: 8, mono: 0, fx: [0, 0, 35, 20], pat: 13 },
  { name: "SYNC LEAD", e: [9, 9, 0, 0, 0, 82, 30, 64], env: [2, 70, 100, 40], fenv: 18, mono: 1, fx: [0, 10, 40, 25], pat: 4 },
  { name: "RING BELL", e: [13, 0, 18, 6, 1, 96, 30, 64], env: [0, 92, 0, 80], fenv: 0, mono: 0, fx: [0, 20, 35, 55], pat: 7 },
  { name: "CHIP CHOIR", e: [1, 0, 12, 7, 1, 62, 95, 40], env: [70, 90, 110, 85], fenv: 30, mono: 0, fx: [0, 50, 20, 65], pat: 5 },
];
export const WHEEL_PRESETS: Preset[] = [
  { name: "FULL ORGAN", e: [15, 0, 0, 0, 0, 30, 20, 1], env: [0, 64, 127, 45], fenv: 0, mono: 0, fx: [0, 0, 10, 35], pat: 5 },
  { name: "JAZZ PERC", e: [4, 0, 0, 0, 2, 50, 8, 1], env: [0, 64, 127, 40], fenv: 0, mono: 0, fx: [0, 0, 0, 25], pat: 3 },
  { name: "GOSPEL", e: [6, 0, 0, 0, 1, 60, 40, 2], env: [0, 64, 127, 45], fenv: 0, mono: 0, fx: [0, 0, 0, 40], pat: 6 },
  { name: "SOFT FLUTE", e: [1, 0, -2, 0, 0, 10, 0, 1], env: [0, 64, 127, 55], fenv: 0, mono: 0, fx: [0, 20, 15, 55], pat: 5 },
  { name: "ROCK DRIVE", e: [7, 0, 0, 0, 0, 70, 100, 2], env: [0, 64, 127, 40], fenv: 0, mono: 0, fx: [35, 0, 10, 25], pat: 4 },
];
export const NOISE_PRESETS: Preset[] = [
  { name: "WIND", e: [0, 64, 70, 100, 127, 0, 70, 0], env: [90, 90, 110, 90], fenv: 0, mono: 0, fx: [0, 30, 20, 80], pat: 5 },
  { name: "RAIN", e: [1, 30, 88, 80, 64, 105, 40, 0], env: [10, 90, 127, 70], fenv: 0, mono: 0, fx: [0, 0, 20, 70], pat: 5 },
  { name: "ARCADE", e: [2, 0, 127, 0, 127, 112, 0, 84], env: [0, 80, 0, 50], fenv: 0, mono: 0, fx: [0, 0, 10, 20], pat: 3 },
  { name: "METAL", e: [3, 0, 100, 40, 100, 32, 0, 0], env: [0, 75, 40, 60], fenv: 10, mono: 0, fx: [0, 20, 30, 45], pat: 7 },
];
export const PHASE_PRESETS: Preset[] = [
  { name: "BRASS", e: [0, 0, 30, 90, 0, 0, 0, 0], env: [8, 70, 90, 40], fenv: 0, mono: 0, fx: [0, 20, 20, 40], pat: 6 },
  { name: "ORGAN", e: [3, 0, 40, 0, 0, 0, 0, 0], env: [0, 127, 127, 30], fenv: 0, mono: 0, fx: [0, 40, 0, 30], pat: 6 },
  { name: "STRING", e: [0, 4, 50, 40, 12, 0, 0, 0], env: [40, 90, 100, 70], fenv: 0, mono: 0, fx: [0, 50, 20, 60], pat: 5 },
  { name: "RESO", e: [5, 0, 60, 60, 0, 0, 0, 0], env: [0, 70, 30, 60], fenv: 0, mono: 0, fx: [0, 0, 40, 40], pat: 1 },
  { name: "BELL", e: [6, 0, 80, 50, 0, 0, 0, 0], env: [0, 95, 0, 90], fenv: 0, mono: 0, fx: [0, 0, 30, 70], pat: 7 },
  { name: "WIRE", e: [4, 7, 70, 40, 7, 0, 0, 0], env: [10, 80, 80, 60], fenv: 0, mono: 0, fx: [15, 30, 30, 40], pat: 4 },
];
