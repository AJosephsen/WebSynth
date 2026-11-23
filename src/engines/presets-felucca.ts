// Presets of Felucca's own engines (GPL-3.0-only), extracted from the C sources. See NOTICE.
import type { Preset } from "./presets";
export const FORMANT_PRESETS: Preset[] = [
  { name: "CHOIR AAH", e: [0, 0, 0, 0, 40, 22, 60, 0], env: [85, 90, 115, 95], fenv: 0, mono: 0, fx: [0, 70, 15, 90], pat: 5 },
  { name: "VOX LEAD", e: [32, 0, 0, 2, 90, 8, 72, 0], env: [6, 70, 105, 55], fenv: 0, mono: 1, fx: [0, 20, 45, 40], pat: 4 },
  { name: "WOW BASS", e: [95, 0, 68, 0, 100, 0, 80, 0], env: [0, 70, 70, 30], fenv: 0, mono: 1, fx: [10, 0, 10, 10], pat: 8 },
  { name: "WHISPER", e: [0, 95, 88, 3, 50, 120, 50, 0], env: [50, 90, 110, 90], fenv: 0, mono: 0, fx: [0, 40, 30, 70], pat: 5 },
];
export const PHYS_PRESETS: Preset[] = [
  { name: "BELL TREE", e: [0, 70, 100, 106, 12, 100, 0, 6], env: [0, 100, 127, 96], fenv: 0, mono: 0, fx: [0, 20, 30, 60], pat: 7 },
  { name: "MARIMBA", e: [0, 116, 38, 40, 24, 90, 0, 30], env: [0, 90, 127, 52], fenv: 0, mono: 0, fx: [0, 0, 15, 30], pat: 6 },
  { name: "PLUCK", e: [1, 56, 72, 84, 40, 96, 0, 0], env: [0, 100, 127, 58], fenv: 0, mono: 0, fx: [0, 10, 30, 30], pat: 3 },
  { name: "BOWED METAL", e: [0, 98, 70, 112, 10, 80, 90, 0], env: [60, 90, 127, 90], fenv: 0, mono: 0, fx: [0, 40, 20, 70], pat: 5 },
  { name: "KALIMBA", e: [0, 34, 16, 56, 100, 90, 0, 48], env: [0, 100, 127, 60], fenv: 0, mono: 0, fx: [0, 10, 20, 40], pat: 7 },
  { name: "HAND DRUM", e: [2, 112, 76, 56, 44, 100, 14, 24], env: [0, 100, 127, 64], fenv: 0, mono: 0, fx: [0, 0, 10, 30], pat: 6 },
  { name: "TOMS", e: [2, 0, 52, 40, 30, 100, 40, 30], env: [0, 100, 127, 70], fenv: 0, mono: 0, fx: [0, 0, 0, 40], pat: 2 },
  { name: "DRONE STRING", e: [3, 127, 80, 88, 64, 100, 92, 0], env: [0, 100, 127, 90], fenv: 0, mono: 0, fx: [0, 10, 20, 50], pat: 3 },
  { name: "HARP", e: [3, 8, 62, 74, 60, 90, 0, 0], env: [0, 100, 127, 80], fenv: 0, mono: 0, fx: [0, 20, 20, 60], pat: 3 },
];
export const GRAIN_PRESETS: Preset[] = [
  { name: "CLOUD PAD", e: [2, 50, 92, 88, 0, 40, 14, 100], env: [70, 90, 120, 90], fenv: 0, mono: 0, fx: [0, 40, 25, 85], pat: 5 },
  { name: "GLITCH", e: [3, 64, 24, 112, 0, 100, 90, 127], env: [0, 70, 100, 30], fenv: 0, mono: 0, fx: [10, 0, 50, 25], pat: 4 },
  { name: "FROZEN", e: [0, 40, 108, 72, 0, 0, 10, 92], env: [50, 100, 127, 100], fenv: 0, mono: 0, fx: [0, 30, 20, 95], pat: 5 },
  { name: "SHIMMER", e: [0, 30, 70, 100, 12, 30, 24, 110], env: [30, 90, 110, 90], fenv: 0, mono: 0, fx: [0, 50, 40, 90], pat: 7 },
];
export const SAMPLE_PRESETS: Preset[] = [
  { name: "PIANO", e: [0, 0, 0, 1, 127, 0, 0, 0], env: [0, 127, 127, 70], fenv: 0, mono: 0, fx: [0, 0, 0, 0], pat: 0 },
  { name: "PIANO", e: [0, 0, 0, 1, 127, 0, 0, 0], env: [0, 127, 127, 70], fenv: 0, mono: 0, fx: [0, 0, 0, 0], pat: 0 },
  { name: "FLUTE", e: [2, 0, 0, 1, 127, 0, 0, 0], env: [12, 80, 120, 60], fenv: 0, mono: 0, fx: [0, 0, 0, 0], pat: 0 },
  { name: "SAX", e: [3, 0, 0, 1, 127, 0, 0, 0], env: [12, 80, 120, 60], fenv: 0, mono: 0, fx: [0, 0, 0, 0], pat: 0 },
];
