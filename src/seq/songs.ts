// Demo songs in four styles: arrangements of 32-step patterns over a four-chord loop, written in a compact notation.
//   a token is "." (rest), or notes joined by "+" ("c4", "a3+c4+e4", drum letters k s h o c t r b), then ":gate" (steps)
//   and "/velocity": "a3+c4+e4:2.5/90". A bar is 16 tokens.
import { MD_CUT, MD_SHP, MS_LFO } from "../mod/mod";
import { defaultMod, ModSetup } from "../mod/setup";
import { defaultMix, defaultSongFx, emptyPattern, MAX_STEPS, MixSetup, Pattern, Song, SongFx, Step, TRACKS } from "./song";

const PC: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const DRUM: Record<string, number> = { k: 36, r: 37, s: 38, c: 39, h: 42, t: 45, o: 46, b: 56 };
const NAMES = ["c", "c#", "d", "d#", "e", "f", "f#", "g", "g#", "a", "a#", "b"];

function midi(tok: string): number {
  const d = DRUM[tok];
  if (d !== undefined) return d;
  const m = /^([a-g])([#b]?)(-?\d)$/.exec(tok);
  if (!m) throw new Error(`bad note "${tok}"`);
  return 12 * (Number(m[3]) + 1) + PC[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
}
const name = (n: number): string => NAMES[n % 12] + (Math.floor(n / 12) - 1);
/** "f4 a4 c5" to MIDI numbers. */
const chord = (s: string): number[] => s.split(/\s+/).map(midi);
const join = (notes: number[], suffix = ""): string => notes.map(name).join("+") + suffix;

function bar(src: string | string[], drum = false): Step[] {
  const toks = typeof src === "string" ? src.trim().split(/\s+/) : src;
  if (toks.length !== 16) throw new Error(`a bar needs 16 tokens, got ${toks.length}: ${toks.join(" ")}`);
  return toks.map((t): Step => {
    if (t === ".") return null;
    const m = /^([^:/]+)(?::([\d.]+))?(?:\/(\d+))?$/.exec(t);
    if (!m) throw new Error(`bad token "${t}"`);
    return { notes: m[1].split("+").map(midi), gate: m[2] ? Number(m[2]) : drum ? 0.5 : 0.9, vel: m[3] ? Number(m[3]) : undefined };
  });
}

/** A pattern of one or two bars per track (a track with no bars rests). Drum tracks default to short gates. */
function pattern(label: string, tracks: (string | string[])[][], drumTracks: number[] = []): Pattern {
  const bars = Math.max(...tracks.map((t) => t.length));
  const p = emptyPattern(label, Math.min(MAX_STEPS, bars * 16));
  tracks.slice(0, TRACKS).forEach((t, i) => t.forEach((b, k) => bar(b, drumTracks.includes(i)).forEach((s, j) => (p.steps[i][k * 16 + j] = s))));
  return p;
}

interface TrackDef { patch: string; mix?: Partial<MixSetup>; mod?: Partial<ModSetup> }
function song(bpm: number, swing: number, defs: TrackDef[], fx: Partial<SongFx>, patterns: Pattern[], arrangement: number[]): Song {
  return {
    bpm, swing,
    tracks: defs.map((d) => ({ patch: d.patch, mute: false, ...defaultMix(), ...d.mix, mod: d.mod ? { ...defaultMod(), ...d.mod } : undefined })),
    fx: { ...defaultSongFx(), ...fx },
    patterns, arrangement,
  };
}

/** Pulls a rhythm string with the placeholders X (the whole chord), L (its lowest) and T (its highest note). */
function comp(rhythm: string, notes: number[]): string {
  return rhythm.split(/\s+/).map((t) => {
    const m = /^([XLT])(.*)$/.exec(t);
    if (!m) return t;
    return (m[1] === "X" ? join(notes) : m[1] === "L" ? name(notes[0]) : name(notes[notes.length - 1])) + m[2];
  }).join(" ");
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. Sunrise sequence: 70s synthesizer pop in the spirit of Jean-Michel Jarre (A minor, bubbling arpeggio, strings, lead)
// ---------------------------------------------------------------------------------------------------------------------
function sunrise(): Song {
  const arpIdx = [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 3, 2, 1, 2];
  const arp = (c: string): string => {
    const n = chord(c);
    const pool = [n[0], n[1], n[2], n[0] + 12];
    return arpIdx.map((k, s) => `${name(pool[k])}:0.8/${s % 4 === 0 ? 112 : 78}`).join(" ");
  };
  const pulse = (root: string): string => Array.from({ length: 8 }, (_, k) => `${root}:1.5/${k === 0 ? 110 : k === 4 ? 100 : 88} .`).join(" ");
  const padc = (c: string): string => `${join(chord(c), ":15.5/80")} ${". ".repeat(15).trim()}`;
  const theme: Record<string, string> = {
    am: "e5:3 . . d5 c5:3 . . a4 e5:4 . . . . . . .",
    f: "c5:3 . . a4 f5:3 . . e5 c5:4 . . . . . . .",
    c: "e5:3 . . g5 e5:3 . . d5 c5:4 . . . d5:2 . e5:2 .",
    g: "d5:3 . . b4 g4:3 . . b4 d5:6 . . . . . . .",
  };
  const arps = { am: arp("a4 c5 e5"), f: arp("f4 a4 c5"), c: arp("e4 g4 c5"), g: arp("d4 g4 b4") };
  const pads = { am: padc("a3 c4 e4"), f: padc("f3 a3 c4"), c: padc("g3 c4 e4"), g: padc("g3 b3 d4") };
  const bass = { am: pulse("a2"), f: pulse("f2"), c: pulse("c3"), g: pulse("g2") };
  const make = (label: string, use: boolean[]): Pattern[] =>
    [["am", "f"], ["c", "g"]].map(([x, y], i) =>
      pattern(`${label} ${i + 1}`, [
        use[0] ? [arps[x as "am"], arps[y as "am"]] : [],
        use[1] ? [pads[x as "am"], pads[y as "am"]] : [],
        use[2] ? [theme[x], theme[y]] : [],
        use[3] ? [bass[x as "am"], bass[y as "am"]] : [],
      ]));
  const [i1, i2] = make("Intro", [true, false, false, true]);
  const [v1, v2] = make("Verse", [true, true, false, true]);
  const [t1, t2] = make("Theme", [true, true, true, true]);
  const [o1, o2] = make("Outro", [true, true, false, false]);
  return song(118, 0, [
    { patch: "ANALOG/PLUCK", mix: { level: 100, pan: -25, delay: 50, reverb: 20 }, mod: { rate: 45, slots: [{ src: MS_LFO, dst: MD_CUT, amt: 35 }, { src: 0, dst: 0, amt: 0 }, { src: 0, dst: 0, amt: 0 }, { src: 0, dst: 0, amt: 0 }] } },
    { patch: "ANALOG/PWM STR", mix: { level: 92, pan: 25, chorus: 55, reverb: 45 }, mod: { rate: 30, slots: [{ src: MS_LFO, dst: MD_SHP, amt: 40 }, { src: 0, dst: 0, amt: 0 }, { src: 0, dst: 0, amt: 0 }, { src: 0, dst: 0, amt: 0 }] } },
    { patch: "ANALOG/SAW LEAD", mix: { level: 98, delay: 55, reverb: 38 }, mod: { rate: 85, ldPit: 12, fade: 70 } },
    { patch: "ANALOG/SUB BASS", mix: { level: 108 } },
  ], { dtime: 10, dfdbk: 55, dcolor: 70, dmix: 85, rtype: 2, rsize: 100, rdamp: 50, crate: 30, cdepth: 70 },
  [i1, i2, v1, v2, t1, t2, o1, o2], [0, 1, 2, 3, 4, 5, 2, 3, 4, 5, 6, 7]);
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. Neon heartbeat: 80s pop (C major, F G Em Am, gated drums, synth bass, brass stabs, saw lead)
// ---------------------------------------------------------------------------------------------------------------------
function neon(): Song {
  const drums = "k+h . h . s+h . h . k+h . k+h . s+h . h o";
  const fill = "k+h . h . s+h . h . k+h . h . s s s+c s";
  const lite = "k . h . k . h . k . h . k . h .";
  const bassBar = (r: number): string => [0, 0, 0, 12, 0, 0, 12, 0].map((o) => `${name(r + o)}:0.8 .`).join(" ");
  const stab = (c: string): string => comp(". . X:0.5 . . . X:0.5 . . . X:0.5 . . . X:0.5 .", chord(c));
  const lead: Record<string, string> = {
    f: "a5:2 . c6:2 . a5 . g5 . f5:4 . . . . . . .",
    g: "g5:2 . b5:2 . g5 . f5 . d5:4 . . . . . . .",
    e: "e5:2 . g5:2 . b5 . a5 . g5:4 . . . e5:2 . g5:2 .",
    a: "a5:3 . . g5 e5:3 . . c5 a4:6 . . . . . . .",
  };
  const roots: Record<string, number> = { f: midi("f2"), g: midi("g2"), e: midi("e2"), a: midi("a2") };
  const stabs: Record<string, string> = { f: stab("f4 a4 c5"), g: stab("g4 b4 d5"), e: stab("e4 g4 b4"), a: stab("a4 c5 e5") };
  const pairs = [["f", "g"], ["e", "a"]];
  const make = (label: string, useBass: boolean, useLead: boolean, lastFill: boolean, lite0 = false): Pattern[] =>
    pairs.map(([x, y], i) =>
      pattern(`${label} ${i + 1}`, [
        [lite0 ? lite : drums, lastFill && i === 1 ? fill : drums],
        useBass ? [bassBar(roots[x]), bassBar(roots[y])] : [],
        [stabs[x], stabs[y]],
        useLead ? [lead[x], lead[y]] : [],
      ], [0]));
  const [i1, i2] = make("Intro", false, false, false, true);
  const [v1, v2] = make("Verse", true, false, false);
  const [c1, c2] = make("Chorus", true, true, true);
  return song(120, 0, [
    { patch: "DRUM/80 KIT", mix: { level: 112, reverb: 35 } },
    { patch: "SYN BASS", mix: { level: 108 } },
    { patch: "ANALOG/BRASS", mix: { level: 86, pan: -15, chorus: 35, delay: 20, reverb: 25 } },
    { patch: "ANALOG/SAW LEAD", mix: { level: 96, pan: 15, delay: 38, reverb: 30 }, mod: { rate: 88, ldPit: 10, fade: 60 } },
  ], { dtime: 1, dfdbk: 45, dcolor: 75, dmix: 80, rtype: 0, rsize: 85, rdamp: 40, crate: 35, cdepth: 55 },
  [i1, i2, v1, v2, c1, c2], [0, 1, 2, 3, 4, 5, 2, 3, 4, 5]);
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. Basement tape: 90s boom bap (A minor, swung drums, sub bass, Rhodes comping, vibraphone)
// ---------------------------------------------------------------------------------------------------------------------
function basement(): Song {
  const d1 = "k+h . h . s+h . h k h . k+h . s+h . o .";
  const d2 = "k+h . h . s+h . h k h . k+h s/50 s+h . h .";
  const bassBar = (r: string): string => `${r}:3/110 . . . . . . ${r}:2/95 . . ${r}:1.5/100 . . . . .`;
  const compA = (c: string): string => comp("X:2.5/100 . . X:1.5/75 . . X:1/70 . . . X:2/95 . . . . .", chord(c));
  const compB = (c: string): string => comp("X:2.5/100 . . X:1.5/75 . . . . X:1/70 . . X:2/90 . . . .", chord(c));
  const keys = { am7: "a3 e4 g4 c5", d9: "d4 f#4 c5 e5", fm7: "f4 a4 c5 e5", e7: "e4 g#4 b4 d5" };
  const vibes1 = ["e5:2 . . . g5:1 . e5:3 . . . . . . . . .", ". . . . c5:2 . . a4:3 . . . f#4:2 . . . ."];
  const vibes2 = ["a4:2 . c5:2 . e5:4 . . . . . . . . . . .", "g#4:2 . . b4:2 . . d5:4 . . . . . . . . ."];
  const intro = pattern("Intro", [[], [], [compA(keys.am7), compB(keys.d9)], vibes1], [0]);
  const a = pattern("Beat A", [[d1, d2], [bassBar("a1"), bassBar("d2")], [compA(keys.am7), compB(keys.d9)], []], [0]);
  const b = pattern("Beat B", [[d1, d2], [bassBar("f1"), bassBar("e1")], [compA(keys.fm7), compB(keys.e7)], vibes2], [0]);
  const c = pattern("Beat A + vibes", [[d1, d2], [bassBar("a1"), bassBar("d2")], [compA(keys.am7), compB(keys.d9)], vibes1], [0]);
  return song(90, 0.2, [
    { patch: "DRUM/DEEP KIT", mix: { level: 114, reverb: 12 } },
    { patch: "ANALOG/SUB BASS", mix: { level: 110 } },
    { patch: "TINE EP", mix: { level: 100, pan: -10, chorus: 40, reverb: 22, itype: 6, imix: 40, ia: 30, ib: 90, ic: 70 } },
    { patch: "VIBES", mix: { level: 82, pan: 22, delay: 40, reverb: 32 } },
  ], { dtime: 10, dfdbk: 45, dcolor: 55, dmix: 70, rtype: 1, rsize: 70, rdamp: 60, crate: 25, cdepth: 50 },
  [intro, a, b, c], [0, 1, 1, 2, 3, 1, 2, 0]);
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. Velvet Rhodes: a slow, cool groove at 78 BPM (D minor, Dm9 Gm9 Bbmaj9 A7b9; Rhodes riff, slap bass, pocket drums, pad)
// ---------------------------------------------------------------------------------------------------------------------
function velvet(): Song {
  const dkA = "k+h h/60 h h/50 s+h h/55 h k h h/60 k+h h/50 s+h h/60 o s/40";
  const dkB = "k+h h/60 h h/50 s+h h/55 h k h h/60 k+h s/35 s+h h/60 h k/60";
  const bassBar = (r: number, alt: boolean): string => {
    const t = Array<string>(16).fill(".");
    t[0] = `${name(r)}:2/112`; t[3] = `${name(r)}:1/80`; t[5] = `${name(r + 12)}:1/92`; t[7] = `${name(r)}:1/85`;
    t[10] = `${name(r)}:2/102`; t[13] = `${name(r + 7)}:1/85`; t[14] = alt ? `${name(r + 12)}:1/90` : `${name(r)}:1/80`;
    return t.join(" ");
  };
  const R1 = "X:2 . . X:1 . X:1 . . X:2 . . X:1 . X . .";
  const R2 = "X:2 . . X:1 . X:1 . . X:2 . . X:1 . L T X:1";
  const ch = { dm9: "f4 a4 c5 e5", gm9: "f4 a4 bb4 d5", bbm9: "a4 c5 d5 f5", a7: "g4 bb4 c#5 e5" };
  const riff = (c: string, i: number): string => comp(i === 0 ? R1 : R2, chord(c));
  const padBar = (c: string): string => `${join(chord(c).map((n) => n - 12), ":15.5/70")} ${". ".repeat(15).trim()}`;
  const roots = { dm9: midi("d2"), gm9: midi("g1"), bbm9: midi("bb1"), a7: midi("a1") };
  const pairs: [keyof typeof ch, keyof typeof ch][] = [["dm9", "gm9"], ["bbm9", "a7"]];
  const make = (label: string, use: boolean[]): Pattern[] =>
    pairs.map(([x, y], i) =>
      pattern(`${label} ${i + 1}`, [
        use[0] ? [dkA, i === 1 ? dkB : dkA] : [],
        use[1] ? [bassBar(roots[x], false), bassBar(roots[y], true)] : [],
        [riff(ch[x], 0), riff(ch[y], 1)],
        use[2] ? [padBar(ch[x]), padBar(ch[y])] : [],
      ], [0]));
  const [i1, i2] = make("Intro", [false, false, true]);
  const [g1, g2] = make("Groove", [true, true, true]);
  const [b1, b2] = make("Break", [false, true, true]);
  return song(78, 0.14, [
    { patch: "DRUM/DRUM KIT", mix: { level: 104, reverb: 14 } },
    { patch: "SLAP BASS", mix: { level: 106 } },
    { patch: "TINE EP", mix: { level: 104, pan: -8, chorus: 45, delay: 28, reverb: 24, itype: 8, imix: 35, ia: 40, ib: 80, ic: 40 } },
    { patch: "WARM PAD", mix: { level: 66, pan: 12, chorus: 30, reverb: 60 } },
  ], { dtime: 10, dfdbk: 42, dcolor: 55, dmix: 70, rtype: 2, rsize: 95, rdamp: 55, crate: 25, cdepth: 55 },
  [i1, i2, g1, g2, b1, b2], [0, 1, 2, 3, 2, 3, 4, 5, 2, 3, 2, 3]);
}

export interface DemoSong { id: string; title: string; genre: string; build: () => Song }

export const demoSongs: DemoSong[] = [
  { id: "sunrise", title: "Sunrise Sequence", genre: "70s synth pop (Jarre style) · 118 BPM", build: sunrise },
  { id: "neon", title: "Neon Heartbeat", genre: "80s pop · 120 BPM", build: neon },
  { id: "basement", title: "Basement Tape", genre: "90s hip hop · 90 BPM, swung", build: basement },
  { id: "velvet", title: "Velvet Rhodes", genre: "Slow groove, Rhodes riff with drums and bass · 78 BPM", build: velvet },
];
