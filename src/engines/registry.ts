// The six ported engines with their presets. See NOTICE.
import { ENG_ANALOG } from "./analog";
import { ENG_LOFI } from "./lofi";
import { ENG_NOISE } from "./noise";
import { ENG_PHASE } from "./phase";
import { ENG_TRIO } from "./trio";
import { ENG_FORMANT } from "./formant";
import { ENG_PHYS } from "./phys";
import { FORMANT_PRESETS, PHYS_PRESETS } from "./presets-felucca";
import { ENG_WHEEL } from "./wheel";
import { ANALOG_PRESETS, LOFI_PRESETS, NOISE_PRESETS, PHASE_PRESETS, Preset, TRIO_PRESETS, WHEEL_PRESETS } from "./presets";
import { EngineDef } from "./types";

export interface EngineEntry { id: string; def: EngineDef; presets: Preset[] }

export const ENGINES: EngineEntry[] = [
  { id: "ANALOG", def: ENG_ANALOG, presets: ANALOG_PRESETS },
  { id: "LOFI", def: ENG_LOFI, presets: LOFI_PRESETS },
  { id: "TRIO", def: ENG_TRIO, presets: TRIO_PRESETS },
  { id: "WHEEL", def: ENG_WHEEL, presets: WHEEL_PRESETS },
  { id: "NOISE", def: ENG_NOISE, presets: NOISE_PRESETS },
  { id: "PHASE", def: ENG_PHASE, presets: PHASE_PRESETS },
  { id: "VOICE", def: ENG_FORMANT, presets: FORMANT_PRESETS },
  { id: "PHYS", def: ENG_PHYS, presets: PHYS_PRESETS },
];

export const engineById = (id: string): EngineEntry | undefined => ENGINES.find((e) => e.id === id);
