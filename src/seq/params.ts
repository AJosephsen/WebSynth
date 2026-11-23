// The track parameters sequencer locks, step automation and MIDI learn can move, with their ranges.
import {
  P_ATK, P_CHOR, P_DEC, P_DETUNE, P_DIST, P_DLY, P_E0, P_ED_FLT, P_ED_PIT, P_ED_SHP, P_GLIDE, P_LD_AMP, P_LD_FLT, P_LD_PIT, P_LD_SHP,
  P_LFADE, P_LRATE, P_PAN, P_REL, P_REV, P_SPRD, P_SUS,
} from "../engines/types";
import type { EngineDef } from "../engines/types";

export interface MParam { id: number; label: string; min: number; max: number }
const MOTION_FIXED: MParam[] = [
  { id: P_ATK, label: "Attack", min: 0, max: 127 }, { id: P_DEC, label: "Decay", min: 0, max: 127 }, { id: P_SUS, label: "Sustain", min: 0, max: 127 },
  { id: P_REL, label: "Release", min: 0, max: 127 }, { id: P_ED_FLT, label: "Env > filter", min: -64, max: 63 },
  { id: P_ED_PIT, label: "Env > pitch", min: -64, max: 63 }, { id: P_ED_SHP, label: "Env > shape", min: -64, max: 63 },
  { id: P_LRATE, label: "LFO rate", min: 0, max: 127 }, { id: P_LFADE, label: "LFO fade", min: 0, max: 127 },
  { id: P_LD_PIT, label: "LFO > pitch", min: -64, max: 63 }, { id: P_LD_FLT, label: "LFO > filter", min: -64, max: 63 },
  { id: P_LD_SHP, label: "LFO > shape", min: -64, max: 63 }, { id: P_LD_AMP, label: "LFO > amp", min: 0, max: 127 },
  { id: P_DIST, label: "Dist", min: 0, max: 127 }, { id: P_CHOR, label: "Chorus send", min: 0, max: 127 },
  { id: P_DLY, label: "Delay send", min: 0, max: 127 }, { id: P_REV, label: "Reverb send", min: 0, max: 127 },
  { id: P_PAN, label: "Pan", min: -64, max: 63 }, { id: P_GLIDE, label: "Glide", min: 0, max: 127 },
  { id: P_DETUNE, label: "Detune", min: 0, max: 127 }, { id: P_SPRD, label: "Spread", min: 0, max: 127 },
];

/** The parameters of a track: the fixed ones and, for an engine, its E1..E8. */
export function motionParams(def?: EngineDef): MParam[] {
  const list = [...MOTION_FIXED];
  def?.edit.forEach((d, k) => list.push({ id: P_E0 + k, label: `E${k + 1} ${d.label}`, min: d.min, max: d.max }));
  return list;
}
