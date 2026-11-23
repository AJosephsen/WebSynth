// Presets of Felucca's own engines (GPL-3.0-only), extracted from the C sources. See NOTICE.
import type { Preset } from "./presets";
export const FORMANT_PRESETS: Preset[] = [
  { name: "CHOIR AAH", e: [0, 0, 0, 0, 40, 22, 60, 0], env: [85, 90, 115, 95], fenv: 0, mono: 0, fx: [0, 70, 15, 90], pat: 5 },
  { name: "VOX LEAD", e: [32, 0, 0, 2, 90, 8, 72, 0], env: [6, 70, 105, 55], fenv: 0, mono: 1, fx: [0, 20, 45, 40], pat: 4 },
  { name: "WOW BASS", e: [95, 0, 68, 0, 100, 0, 80, 0], env: [0, 70, 70, 30], fenv: 0, mono: 1, fx: [10, 0, 10, 10], pat: 8 },
  { name: "WHISPER", e: [0, 95, 88, 3, 50, 120, 50, 0], env: [50, 90, 110, 90], fenv: 0, mono: 0, fx: [0, 40, 30, 70], pat: 5 },
];
