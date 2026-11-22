// Patch library: Felucca's factory voices, DX7 SysEx import/export and user patches kept in the browser.
// See NOTICE.
import { bankVoices } from "./bank";
import { FACTORY } from "./factory";
import { buildBankSysex, parseSysex, patchName, unpack } from "./patch";

export interface LibraryPatch {
  name: string;
  patch: Uint8Array; // 155-byte voice
  note: number; // a sensible MIDI note to audition it on
  source: "factory" | "user";
  bank: string; // the group it is listed under
}

const AUDITION: Record<string, number> = { "FM BASS": 36, "SLAP BASS": 36, "SYN BASS": 36, "SUB BASS": 36, "PIPE ORG": 48, GLOCK: 72 };

export function toLibraryPatch(patch: Uint8Array, source: "factory" | "user", name = patchName(patch), bank = source === "user" ? "User" : "Factory"): LibraryPatch {
  return { name, patch, note: AUDITION[name] ?? 60, source, bank };
}

// INIT, Felucca's 8 voices, then WebSynth's own bank
export const factoryPatches: LibraryPatch[] = [
  ...FACTORY.map((f) => toLibraryPatch(unpack(f.packed), "factory", f.name, f.name === "INIT" ? "Init" : "Felucca")),
  ...bankVoices.map((v) => toLibraryPatch(v, "factory", patchName(v), "WebSynth")),
];

export function byName(name: string): LibraryPatch {
  const p = factoryPatches.find((x) => x.name === name);
  if (!p) throw new Error(`no factory patch ${name}`);
  return p;
}

/** Voices in a DX7 .syx file (a 32-voice bank or single voices). */
export function loadSysex(data: Uint8Array): LibraryPatch[] {
  return parseSysex(data).map((v) => toLibraryPatch(v, "user"));
}

/** Patches as one .syx bank (the first 32). */
export function exportBank(patches: LibraryPatch[]): Uint8Array {
  return buildBankSysex(patches.slice(0, 32).map((p) => p.patch));
}

const KEY = "websynth.library.v1";

/** The user's patches, stored in this browser. */
export function loadUserPatches(): LibraryPatch[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as number[][]).map((a) => toLibraryPatch(Uint8Array.from(a), "user"));
  } catch {
    return [];
  }
}

export function saveUserPatches(patches: LibraryPatch[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(patches.filter((p) => p.source === "user").map((p) => [...p.patch])));
  } catch {
    // storage unavailable: the library still works for this session
  }
}
