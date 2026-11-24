// Demo songs in four styles: arrangements of 32-step patterns over a four-chord loop, written in a compact notation.
//   a token is "." (rest), or notes joined by "+" ("c4", "a3+c4+e4", drum letters k s h o c t r b), then ":gate" (steps)
//   and "/velocity": "a3+c4+e4:2.5/90". A bar is 16 tokens.
import { MD_CUT, MD_PAN, MD_SHP, MS_LFO, MS_SH, MS_SLEW } from "../mod/mod";
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

const slots = (...s: { src: number; dst: number; amt: number }[]) => [...s, ...Array.from({ length: 4 - s.length }, () => ({ src: 0, dst: 0, amt: 0 }))];

// ---------------------------------------------------------------------------------------------------------------------
// 1. Sunrise Sequence: 70s synthesizer pop in the spirit of Jean-Michel Jarre. A minor, a bubbling arpeggio and a lead
//    thrown into a long dotted echo, phased strings, a pulsing bass; a bridge in D minor
// ---------------------------------------------------------------------------------------------------------------------
function sunrise(): Song {
  const idxA = [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 3, 2, 1, 2];
  const idxB = [0, 2, 4, 3, 1, 2, 4, 3, 0, 2, 3, 4, 2, 1, 3, 4];
  const arp = (c: string, idx: number[]): string => {
    const n = chord(c);
    const pool = [n[0], n[1], n[2], n[0] + 12, n[1] + 12];
    return idx.map((k, st) => `${name(pool[k])}:0.7/${st % 4 === 0 ? 114 : st % 2 === 0 ? 86 : 66}`).join(" ");
  };
  const pulse = (root: string): string => Array.from({ length: 8 }, (_, k) => `${root}:1.5/${k === 0 ? 110 : k === 4 ? 100 : 88} .`).join(" ");
  const padc = (c: string): string => `${join(chord(c), ":15.5/80")} ${". ".repeat(15).trim()}`;
  const harm: Record<string, { arp: string; pad: string; bass: string; lead: string; lead2: string }> = {
    am: { arp: "a4 c5 e5", pad: "a3 c4 e4", bass: "a2", lead: "e5:3 . . d5 c5:3 . . a4 e5:4 . . . . . . .", lead2: "a5:3 . . g5 e5:3 . . g5 a5:4 . . . . . . ." },
    f: { arp: "f4 a4 c5", pad: "a3 c4 f4", bass: "f2", lead: "c5:3 . . a4 f5:3 . . e5 c5:4 . . . . . . .", lead2: "c6:3 . . a5 f5:3 . . a5 c6:4 . . . . . . ." },
    c: { arp: "e4 g4 c5", pad: "g3 c4 e4", bass: "c3", lead: "e5:3 . . g5 e5:3 . . d5 c5:4 . . . d5:2 . e5:2 .", lead2: "g5:3 . . e5 c6:3 . . b5 g5:4 . . . a5:2 . g5:2 ." },
    g: { arp: "d4 g4 b4", pad: "g3 b3 d4", bass: "g2", lead: "d5:3 . . b4 g4:3 . . b4 d5:6 . . . . . . .", lead2: "b5:3 . . a5 g5:3 . . d5 g5:4 . . . . . . ." },
    dm: { arp: "d4 f4 a4", pad: "a3 d4 f4", bass: "d2", lead: "a5:3 . . g5 f5:3 . . e5 d5:4 . . . . . . .", lead2: "a5:3 . . g5 f5:3 . . e5 d5:4 . . . . . . ." },
    e: { arp: "e4 g#4 b4", pad: "g#3 b3 e4", bass: "e2", lead: "g#5:3 . . b5 e6:3 . . d6 b5:6 . . . . . . .", lead2: "g#5:3 . . b5 e6:3 . . d6 b5:6 . . . . . . ." },
  };
  const make = (label: string, pair: string[][], use: boolean[], idx: number[], second = false): Pattern[] =>
    pair.map(([x, y], i) =>
      pattern(`${label} ${i + 1}`, [
        use[0] ? [arp(harm[x].arp, idx), arp(harm[y].arp, idx)] : [],
        use[1] ? [padc(harm[x].pad), padc(harm[y].pad)] : [],
        use[2] ? [second ? harm[x].lead2 : harm[x].lead, second ? harm[y].lead2 : harm[y].lead] : [],
        use[3] ? [pulse(harm[x].bass), pulse(harm[y].bass)] : [],
      ]));
  const main = [["am", "f"], ["c", "g"]], bridge = [["dm", "f"], ["g", "e"]];
  const [i1, i2] = make("Intro", main, [true, false, false, true], idxA);
  const [v1, v2] = make("Verse", main, [true, true, false, true], idxA);
  const [t1, t2] = make("Theme", main, [true, true, true, true], idxB);
  const [b1, b2] = make("Bridge", bridge, [true, true, true, true], idxB, true);
  const [o1, o2] = make("Outro", main, [true, true, false, false], idxA);
  return song(116, 0, [
    { patch: "ANALOG/PLUCK", mix: { level: 106, pan: -30, delay: 92, reverb: 18 }, mod: { rate: 40, slots: slots({ src: MS_LFO, dst: MD_CUT, amt: 38 }) } },
    { patch: "ANALOG/PWM STR", mix: { level: 100, pan: 25, chorus: 60, reverb: 50, itype: 6, imix: 70, ia: 35, ib: 70, ic: 60 }, mod: { rate: 30, slots: slots({ src: MS_LFO, dst: MD_SHP, amt: 42 }) } },
    { patch: "ANALOG/SAW LEAD", mix: { level: 110, delay: 88, reverb: 40 }, mod: { rate: 86, ldPit: 12, fade: 75, slots: slots({ src: MS_SLEW, dst: MD_CUT, amt: 25 }) } },
    { patch: "ANALOG/SUB BASS", mix: { level: 108 } },
  ], { dtime: 10, dfdbk: 78, dcolor: 55, dmix: 105, rtype: 2, rsize: 105, rdamp: 50, crate: 28, cdepth: 70 },
  [i1, i2, v1, v2, t1, t2, b1, b2, o1, o2], [0, 1, 2, 3, 2, 3, 4, 5, 6, 7, 4, 5, 8, 9]);
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
    { patch: "ANALOG/BRASS", mix: { level: 108, pan: -15, chorus: 35, delay: 20, reverb: 25 } },
    { patch: "ANALOG/SAW LEAD", mix: { level: 110, pan: 15, delay: 38, reverb: 30 }, mod: { rate: 88, ldPit: 10, fade: 60 } },
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
    { patch: "VIBES", mix: { level: 104, pan: 22, delay: 40, reverb: 32 } },
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
    { patch: "WARM PAD", mix: { level: 90, pan: 12, chorus: 30, reverb: 60 } },
  ], { dtime: 10, dfdbk: 42, dcolor: 55, dmix: 70, rtype: 2, rsize: 95, rdamp: 55, crate: 25, cdepth: 55 },
  [i1, i2, g1, g2, b1, b2], [0, 1, 2, 3, 2, 3, 4, 5, 2, 3, 2, 3]);
}

// ---------------------------------------------------------------------------------------------------------------------
// 5. Glass Cathedral: an ambient landscape. Granular clouds, a bell tree thrown into a huge echo, choir, wind, shimmer;
//    the matrix drifts the stereo image and the filters
// ---------------------------------------------------------------------------------------------------------------------
function cathedral(): Song {
  const hold = (c: string, g = 15.5, v = 78): string => `${join(chord(c), `:${g}/${v}`)} ${". ".repeat(15).trim()}`;
  const ch = { a: "d3 a3 e4 f#4", b: "b2 f#3 a3 d4", c: "g3 d4 f#4 a4", d: "e3 b3 d4 g4" };
  const hi = { a: "a4 d5 f#5", b: "a4 d5 f#5", c: "b4 d5 f#5", d: "b4 e5 g5" };
  const bells: Record<string, string> = {
    a: "a5:2/90 . . . . . . . . . e6:2/70 . . . . .",
    b: ". . f#5:2/80 . . . . . . d6:2/75 . . . . . .",
    c: ". . . . d6:2/85 . . . f#6:2/65 . . . . . . .",
    d: "b5:2/80 . . . . . g6:2/70 . . . . . e6:2/60 . . .",
  };
  const choir: Record<string, string> = {
    a: "f#4:10/80 . . . . . . . . . a4:5/70 . . . . .",
    b: "d4:16/72 . . . . . . . . . . . . . . .",
    c: "a4:8/80 . . . . . . . f#4:8/70 . . . . . . .",
    d: "g4:12/78 . . . . . . . . . . . b4:4/70 . . .",
  };
  const make = (label: string, pair: string[], use: boolean[]): Pattern =>
    pattern(label, [
      use[0] ? [hold(ch[pair[0] as "a"]), hold(ch[pair[1] as "a"])] : [],
      use[1] ? [bells[pair[0]], bells[pair[1]]] : [],
      use[2] ? [choir[pair[0]], choir[pair[1]]] : [],
      use[3] ? [`${join(chord(hi[pair[0] as "a"]), ":15.5/55")} ${". ".repeat(15).trim()}`, `${join(chord(hi[pair[1] as "a"]), ":15.5/55")} ${". ".repeat(15).trim()}`] : [],
    ]);
  const ab = ["a", "b"], cd = ["c", "d"];
  const dawn1 = make("Dawn 1", ab, [true, false, false, false]), dawn2 = make("Dawn 2", cd, [true, false, false, false]);
  const bell1 = make("Bells 1", ab, [true, true, false, false]), bell2 = make("Bells 2", cd, [true, true, false, false]);
  const choir1 = make("Choir 1", ab, [true, true, true, false]), choir2 = make("Choir 2", cd, [true, true, true, false]);
  const sh1 = make("Shimmer 1", ab, [true, true, true, true]), sh2 = make("Shimmer 2", cd, [true, true, true, true]);
  const fade1 = make("Fade 1", ab, [true, true, false, true]), fade2 = make("Fade 2", cd, [false, true, false, true]);
  return song(68, 0, [
    { patch: "GRAIN/CLOUD PAD", mix: { level: 108, pan: -15, chorus: 40, reverb: 70 }, mod: { rate: 28, slots: slots({ src: MS_LFO, dst: MD_PAN, amt: 30 }) } },
    { patch: "PHYS/BELL TREE", mix: { level: 114, delay: 105, reverb: 75 }, mod: { rate: 50, slots: slots({ src: MS_SH, dst: MD_PAN, amt: 55 }) } },
    { patch: "VOICE/CHOIR AAH", mix: { level: 100, pan: 10, chorus: 25, delay: 35, reverb: 85 } },
    { patch: "GRAIN/SHIMMER", mix: { level: 108, pan: 20, delay: 60, reverb: 90 }, mod: { rate: 22, slots: slots({ src: MS_SLEW, dst: MD_PAN, amt: 60 }) } },
  ], { dtime: 12, dfdbk: 92, dcolor: 45, dmix: 110, rtype: 2, rsize: 127, rdamp: 35, crate: 20, cdepth: 85 },
  [dawn1, dawn2, bell1, bell2, choir1, choir2, sh1, sh2, fade1, fade2], [0, 1, 0, 1, 2, 3, 4, 5, 6, 7, 6, 7, 4, 5, 8, 9]);
}

// ---------------------------------------------------------------------------------------------------------------------
// 6. Dub Chamber: slow dub at 76 BPM. A one-drop beat, deep bass, an organ skank and a flute line, all sent through a
//    dotted-quarter echo with a long feedback tail
// ---------------------------------------------------------------------------------------------------------------------
function dub(): Song {
  const drops = "h . h . h . h . k+r+h . h . h . h .";
  const dropsB = "h . h . h . h . k+r+h . h . h . s s/60";
  const dropsC = "h . h . h . o . k+r+h . h . h . h .";
  const bassBar = (r: string): string => `${r}:5/115 . . . . . ${r}:1/85 . . . ${r}:3/100 . . . . .`;
  const skank = (c: string): string => comp(". . X:0.5/100 . . . X:0.5/82 . . . X:0.5/100 . . . X:0.5/80 .", chord(c));
  const harm: Record<string, { bass: string; chord: string }> = {
    am: { bass: "a1", chord: "a3 c4 e4" }, dm: { bass: "d2", chord: "a3 d4 f4" }, e7: { bass: "e1", chord: "g#3 b3 d4 e4" },
  };
  const flute: Record<string, string> = {
    am: "e5:4 . . . c5:3 . . . . . . . . . . .",
    dm: "d5:3 . . . f5:3 . . . a5:4 . . . . . . .",
    e7: "g#5:3 . . . b5:6 . . . . . . . d6:2 . . .",
  };
  const pairs = [["am", "dm"], ["am", "e7"]];
  const make = (label: string, use: boolean[], d: [string, string]): Pattern[] =>
    pairs.map(([x, y], i) =>
      pattern(`${label} ${i + 1}`, [
        use[0] ? (i === 1 ? [d[0], d[1]] : [d[0], dropsC]) : [],
        use[1] ? [bassBar(harm[x].bass), bassBar(harm[y].bass)] : [],
        [skank(harm[x].chord), skank(harm[y].chord)],
        use[2] ? [flute[x], flute[y]] : [],
      ], [0]));
  const [i1, i2] = make("Intro", [true, false, false], [drops, drops]);
  const [v1, v2] = make("Verse", [true, true, false], [drops, dropsB]);
  const [m1, m2] = make("Melody", [true, true, true], [drops, dropsB]);
  const [d1, d2] = make("Dub", [true, false, true], [drops, dropsB]);
  return song(76, 0.05, [
    { patch: "DRUM/DEEP KIT", mix: { level: 108, delay: 30, reverb: 22 } },
    { patch: "ANALOG/SUB BASS", mix: { level: 112 } },
    { patch: "WHEEL/JAZZ PERC", mix: { level: 106, pan: -12, chorus: 20, delay: 110, reverb: 28 }, mod: { rate: 60, slots: slots({ src: MS_LFO, dst: MD_PAN, amt: 25 }) } },
    { patch: "SAMPLE/FLUTE", mix: { level: 106, pan: 18, delay: 100, reverb: 45 } },
  ], { dtime: 12, dfdbk: 88, dcolor: 50, dmix: 105, rtype: 1, rsize: 90, rdamp: 55, crate: 25, cdepth: 45 },
  [i1, i2, v1, v2, m1, m2, d1, d2], [0, 1, 2, 3, 4, 5, 6, 7, 4, 5, 6, 7]);
}

/**
 * An original piece in a cold, slow style (not a transcription of any song): a CR-78 beat that never hurries, a held minor-key pad, a bass that
 * barely moves, a three-note motif in a long echo, and a tom roll that opens the last section. MIDI 1 plays the same drum part on channel 10
 * (the GM drum notes), so a drum machine behind a MIDI interface can play along with, or instead of, the CR78 kit.
 */
function coldnight(): Song {
  const R = ".", rest = Array(16).fill(R).join(" ");
  const D1 = "h . . . h . . . h . . . h . . .";
  const D2 = "k . h . h . h . s . h . h . h .";
  const D3 = "k . h . h . h . s . h . h . h k";
  const DR = "k . h . r . h . s . h . r . h .";
  const FILL = ". . . . s . s . a2 . b2 . c3 . d3 .";
  const FILL2 = "a2:1/120 . a2/110 . b2/110 . b2/105 . c3/100 . c3/100 . d3/95 . d3/90 .";
  const pad = (c: string) => `${c}:15.5/78 . . . . . . . . . . . . . . .`;
  const Em = "e3+g3+b3", C = "c3+e3+g3", G = "g3+b3+d4", D = "d3+f#3+a3";
  const bass = (n: string) => `${n}:7/100 . . . . . . . ${n}:6/84 . . . . . . .`;
  const motif = (a: string, b: string, c: string) => `${a}:3/84 . . . ${b}:2/76 . . . ${c}:6/80 . . . . . . .`;
  const intro = pattern("Intro", [[D1, D1], [], [pad(Em), pad(C)], []], [0]);
  const intro2 = pattern("Intro 2", [[D1, D1], [], [pad(G), pad(D)], []], [0]);
  const v1 = pattern("Verse 1", [[D2, D2], [bass("e2"), bass("c2")], [pad(Em), pad(C)], [motif("e5", "d5", "b4"), rest]], [0]);
  const v2 = pattern("Verse 2", [[D2, D3], [bass("g2"), bass("d2")], [pad(G), pad(D)], [rest, motif("g5", "f#5", "d5")]], [0]);
  const b1 = pattern("Build", [[DR, FILL], [bass("e2"), bass("c2")], [pad(Em), pad(C)], [motif("e5", "d5", "b4"), rest]], [0]);
  const big1 = pattern("Big 1", [[D3, D2], [bass("e2"), bass("c2")], [pad(Em), pad(C)], [motif("b5", "a5", "e5"), rest]], [0]);
  const big2 = pattern("Big 2", [[D3, FILL2], [bass("g2"), bass("d2")], [pad(G), pad(D)], [rest, motif("g5", "f#5", "d5")]], [0]);
  // the drum part again on MIDI 1 (steps row 4), on channel 10
  const all = [intro, intro2, v1, v2, b1, big1, big2];
  for (const p of all) p.steps[TRACKS] = p.steps[0].map((st) => (st ? { ...st, notes: [...st.notes] } : null));
  const s = song(100, 0, [
    { patch: "DRUM/CR78 KIT", mix: { level: 112, reverb: 30 } },
    { patch: "ANALOG/SUB BASS", mix: { level: 108 } },
    { patch: "ANALOG/PWM STR", mix: { level: 92, pan: -10, chorus: 40, reverb: 55 }, mod: { rate: 4, wave: 1, trig: 1, ldFlt: 40 } },
    { patch: "TINE EP", mix: { level: 100, pan: 14, delay: 100, reverb: 50, chorus: 30 } },
  ], { dtime: 10, dfdbk: 72, dcolor: 45, dmix: 100, rtype: 2, rsize: 115, rdamp: 50, crate: 20, cdepth: 50 },
  all, [0, 1, 2, 3, 2, 3, 4, 5, 6, 5, 6]);
  s.midi = [{ channel: 10, mute: false }, { channel: 2, mute: true }, { channel: 3, mute: true }, { channel: 4, mute: true }];
  s.clockOut = true;
  return s;
}

export interface DemoSong { id: string; title: string; genre: string; build: () => Song }

export const demoSongs: DemoSong[] = [
  { id: "sunrise", title: "Sunrise Sequence", genre: "70s synth pop (Jarre style) · 118 BPM", build: sunrise },
  { id: "neon", title: "Neon Heartbeat", genre: "80s pop · 120 BPM", build: neon },
  { id: "basement", title: "Basement Tape", genre: "90s hip hop · 90 BPM, swung", build: basement },
  { id: "cathedral", title: "Glass Cathedral", genre: "Ambient landscape: clouds, bells in a huge echo, choir · 68 BPM", build: cathedral },
  { id: "dub", title: "Dub Chamber", genre: "Slow dub: one-drop beat, organ skank in a long echo · 76 BPM", build: dub },
  { id: "coldnight", title: "Cold Night", genre: "Slow, cold CR-78 groove with a MIDI drum track on channel 10 · 100 BPM", build: coldnight },
  { id: "velvet", title: "Velvet Rhodes", genre: "Slow groove, Rhodes riff with drums and bass · 78 BPM", build: velvet },
];
