// Patch library: Felucca's factory voices plus anything loaded from DX7 SysEx. See NOTICE.
import { FACTORY } from "./factory";
import { patchName, parseSysex, unpack } from "./patch";

export interface LibraryPatch {
  name: string;
  patch: Uint8Array; // 155-byte voice
  note: number; // a sensible MIDI note to audition it on
}

const AUDITION: Record<string, number> = { "FM BASS": 36, BASS: 36 };

export function toLibraryPatch(patch: Uint8Array, name = patchName(patch)): LibraryPatch {
  return { name, patch, note: AUDITION[name] ?? 60 };
}

export const factoryPatches: LibraryPatch[] = FACTORY.map((f) => toLibraryPatch(unpack(f.packed), f.name));

/** Voices in a DX7 .syx file (a 32-voice bank or single voices). */
export function loadSysex(data: Uint8Array): LibraryPatch[] {
  return parseSysex(data).map((v) => toLibraryPatch(v));
}
