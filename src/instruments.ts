// The instrument library: every sound the app can play, with a stable id (the song stores ids).
//   FM6 voices:      id = the voice name              ("TINE EP")
//   engine presets:  id = "ENGINE/PRESET"             ("ANALOG/SAW LEAD")
import { ENGINES } from "./engines/registry";
import { byName, factoryPatches, LibraryPatch } from "./fm6/library";
import { Instrument, instrumentFromPreset } from "./synth/synth";

export interface LibraryEntry {
  id: string;
  name: string;
  bank: string;
  source: "factory" | "user";
  instrument: Instrument;
  note: number; // a sensible MIDI note to audition it on
  fm6?: LibraryPatch; // the FM6 voice, for the patch editor
}

const AUDITION: Record<string, number> = { "ANALOG/SQR BASS": 36, "ANALOG/SUB BASS": 36, "ANALOG/ACID": 36, "TRIO/FAT BASS": 36, "LOFI/WAVE BASS": 36 };

export function fm6Entry(lp: LibraryPatch): LibraryEntry {
  return { id: lp.name, name: lp.name, bank: lp.bank, source: lp.source, instrument: { kind: "fm6", patch: lp.patch }, note: lp.note, fm6: lp };
}

export const engineEntries: LibraryEntry[] = ENGINES.flatMap((e) =>
  e.presets.map((p): LibraryEntry => {
    const id = `${e.id}/${p.name}`;
    return { id, name: p.name, bank: e.id, source: "factory", instrument: instrumentFromPreset(e.id, p), note: AUDITION[id] ?? 60 };
  }),
);

export const factoryEntries: LibraryEntry[] = [...factoryPatches.map(fm6Entry), ...engineEntries];

/** The instrument of a factory id (a missing id falls back to the INIT voice). */
export function factoryInstrument(id: string): Instrument {
  const e = factoryEntries.find((x) => x.id === id);
  return e ? e.instrument : { kind: "fm6", patch: byName("INIT").patch };
}

const KEY_ENGINES = "websynth.library.engines.v1";

type EngineInstrument = Extract<Instrument, { kind: "engine" }>;

export function userEngineEntry(inst: EngineInstrument, name: string): LibraryEntry {
  return { id: `USER/${name}`, name, bank: "User", source: "user", instrument: inst, note: 60 };
}

/** Engine presets the user saved, kept in this browser. */
export function loadUserEngineEntries(): LibraryEntry[] {
  try {
    const raw = localStorage.getItem(KEY_ENGINES);
    if (!raw) return [];
    return (JSON.parse(raw) as { name: string; inst: EngineInstrument }[]).map((x) => userEngineEntry(x.inst, x.name));
  } catch {
    return [];
  }
}

export function saveUserEngineEntries(entries: LibraryEntry[]): void {
  try {
    const list = entries.filter((e) => e.source === "user" && e.instrument.kind === "engine").map((e) => ({ name: e.name, inst: e.instrument }));
    localStorage.setItem(KEY_ENGINES, JSON.stringify(list));
  } catch {
    // storage unavailable: the library still works for this session
  }
}
