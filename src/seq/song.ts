/** One step: notes (a chord), velocity 1..127 and gate length in steps. null = rest. */
export type Step = { notes: number[]; vel?: number; gate?: number } | null;

export const TRACKS = 4;
export const MAX_STEPS = 32;

export interface Pattern {
  name: string;
  length: number; // 4..32 steps (16ths)
  steps: Step[][]; // [track][step], each MAX_STEPS long
}

export interface TrackSetup {
  patch: string; // instrument id (see instruments.ts); kept by name so a song survives a library change
  mute: boolean;
}

export interface Song {
  bpm: number;
  swing: number; // 0..0.5
  tracks: TrackSetup[];
  patterns: Pattern[]; // up to 16
  arrangement: number[]; // pattern indices, played in order (the pattern sequencer)
}

export const MAX_PATTERNS = 16;
export const MAX_ARRANGEMENT = 32;

export function emptyPattern(name: string, length = 16): Pattern {
  return { name, length, steps: Array.from({ length: TRACKS }, () => Array<Step>(MAX_STEPS).fill(null)) };
}

export function clonePattern(p: Pattern, name = p.name): Pattern {
  return { name, length: p.length, steps: p.steps.map((t) => t.map((s) => (s ? { ...s, notes: [...s.notes] } : null))) };
}

/** Builds a pattern from per-track step lists (shorter lists are padded with rests). */
export function patternFrom(name: string, tracks: Step[][], length = 16): Pattern {
  const p = emptyPattern(name, length);
  tracks.slice(0, TRACKS).forEach((t, i) => t.slice(0, MAX_STEPS).forEach((s, j) => (p.steps[i][j] = s)));
  return p;
}

/** Clamps a song loaded from storage or a file to valid ranges; returns null when it is unusable. */
export function sanitizeSong(raw: unknown): Song | null {
  const s = raw as Partial<Song> | null;
  if (!s || !Array.isArray(s.patterns) || !s.patterns.length || !Array.isArray(s.tracks)) return null;
  const clamp = (x: unknown, lo: number, hi: number, d: number) => (typeof x === "number" && isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);
  const patterns = s.patterns.slice(0, MAX_PATTERNS).map((p, i) => {
    const out = emptyPattern(typeof p?.name === "string" ? p.name.slice(0, 16) : `P${i + 1}`, Math.round(clamp(p?.length, 4, MAX_STEPS, 16)));
    for (let t = 0; t < TRACKS; t++)
      for (let j = 0; j < MAX_STEPS; j++) {
        const st = p?.steps?.[t]?.[j];
        if (st && Array.isArray(st.notes) && st.notes.length)
          out.steps[t][j] = {
            notes: st.notes.map((n) => Math.round(clamp(n, 0, 127, 60))).slice(0, 8),
            vel: Math.round(clamp(st.vel, 1, 127, 100)),
            gate: clamp(st.gate, 0.1, 8, 0.9),
          };
      }
    return out;
  });
  const arrangement = (Array.isArray(s.arrangement) ? s.arrangement : [0])
    .map((i) => Math.round(clamp(i, 0, patterns.length - 1, 0)))
    .slice(0, MAX_ARRANGEMENT);
  const tracks = Array.from({ length: TRACKS }, (_, i) => ({
    patch: typeof s.tracks?.[i]?.patch === "string" ? s.tracks[i].patch : "INIT",
    mute: !!s.tracks?.[i]?.mute,
  }));
  return { bpm: clamp(s.bpm, 40, 240, 104), swing: clamp(s.swing, 0, 0.5, 0), tracks, patterns, arrangement: arrangement.length ? arrangement : [0] };
}

/** The song the app starts with. */
export function defaultSong(): Song {
  const n = (...notes: number[]): Step => ({ notes });
  const _ = null;
  const m = (pc: number, oct: number) => 12 * (oct + 1) + pc;
  const [C, D, E, F, G, A, B] = [0, 2, 4, 5, 7, 9, 11];
  const groove = patternFrom("A groove", [
    [n(m(C, 2)), _, _, n(m(C, 2)), _, _, n(m(G, 1)), _, n(m(A, 1)), _, _, n(m(A, 1)), _, n(m(E, 2)), _, n(m(G, 1))],
    [{ notes: [m(E, 4), m(G, 4), m(B, 4)], gate: 1.8 }, _, _, _, _, _, _, _, { notes: [m(E, 4), m(A, 4), m(C, 5)], gate: 1.8 }, _, _, _, _, _, { notes: [m(D, 4), m(G, 4), m(B, 4)] }, _],
    [_, n(m(G, 5)), _, n(m(E, 5)), _, n(m(C, 5)), _, _, _, n(m(A, 5)), _, n(m(E, 5)), _, n(m(C, 5)), n(m(D, 5)), _],
    [],
  ]);
  const turn = patternFrom("B turn", [
    [n(m(F, 1)), _, _, n(m(F, 1)), _, _, n(m(C, 2)), _, n(m(G, 1)), _, _, n(m(G, 1)), _, n(m(D, 2)), _, n(m(B, 1))],
    [{ notes: [m(F, 4), m(A, 4), m(C, 5)], gate: 1.8 }, _, _, _, _, _, _, _, { notes: [m(G, 4), m(B, 4), m(D, 5)], gate: 3.6 }, _, _, _, _, _, _, _],
    [_, n(m(A, 5)), _, n(m(F, 5)), _, n(m(C, 5)), _, _, _, n(m(B, 5)), _, n(m(G, 5)), _, n(m(D, 5)), n(m(E, 5)), _],
    [{ notes: [m(F, 3), m(A, 3), m(C, 4)], gate: 7.5 }, _, _, _, _, _, _, _, { notes: [m(G, 3), m(B, 3), m(D, 4)], gate: 7.5 }, _, _, _, _, _, _, _],
  ]);
  const breakdown = patternFrom("C breakdown", [
    [],
    [],
    [n(m(E, 5)), _, _, _, n(m(A, 5)), _, _, n(m(C, 6)), _, _, n(m(A, 5)), _, _, _, n(m(F, 5)), _],
    [{ notes: [m(A, 3), m(C, 4), m(E, 4)], gate: 7.5 }, _, _, _, _, _, _, _, { notes: [m(F, 3), m(A, 3), m(C, 4)], gate: 7.5 }, _, _, _, _, _, _, _],
  ]);
  return {
    bpm: 104,
    swing: 0.12,
    tracks: [{ patch: "FM BASS", mute: false }, { patch: "TINE EP", mute: false }, { patch: "MARIMBA", mute: false }, { patch: "WARM PAD", mute: false }],
    patterns: [groove, turn, breakdown, emptyPattern("D empty")],
    arrangement: [2, 0, 0, 1, 0],
  };
}
