// Checks the chord keys with AUTO / AUTO2 harmony against a hash of Melodee's chord.c compiled in a harness (tests/harmony-gold.txt): 6000 random
// operations (clock ticks, observed notes, held keys, sequencer notes, re-configurations, chords made and built) on four parts.
import { readFileSync } from "node:fs";
import { CH_AUTO, CH_MELODY, Harmony, HarmonyTrack, autoChordName, chordName, melodyChordName, newHarmonyTrack, newStrum } from "../src/synth/harmony";

let s = 12345;
const rnd32 = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; };
const rnd = (n: number): number => (rnd32() >>> 8) % n;
let H = 2166136261;
const fnv = (v: number): void => { for (let i = 0; i < 4; i++) { H = Math.imul(H ^ ((v >>> (8 * i)) & 255), 16777619) >>> 0; } };

const tracks: HarmonyTrack[] = Array.from({ length: 4 }, newHarmonyTrack);
let solo = 0, beat = 22050;
const h = new Harmony(tracks, { solo: () => solo, beatSamples: () => beat });
const configure = (k: number): void => {
  const t = tracks[k];
  t.chrd = rnd(12); t.voic = rnd(5);
  t.scale = rnd(10) < 8 ? rnd(16) : 16 + rnd(54);
  t.quant = rnd(5); t.root = rnd(12); t.trans = rnd(9) - 4;
  t.voice = rnd(6) === 0 ? rnd(4) : 0; t.kit = rnd(10) === 0; t.mute = rnd(8) === 0;
  t.octave = rnd(3) - 1; t.mpcdeg = 1;
  t.strum = rnd(9); t.stroke = rnd(3); t.amode = rnd(6) === 0 ? 1 : 0;
};
const hashName = (mode: number, root: number, mask: number): void => {
  const b = mode === CH_AUTO ? autoChordName(root, mask) : mode === CH_MELODY ? melodyChordName(root, mask) : chordName(root, mask);
  for (const c of b) fnv(c.charCodeAt(0));
};
for (let k = 0; k < 4; k++) configure(k);
let builds = 0;
for (let step = 0; step < 6000; step++) {
  const op = rnd(10), k = rnd(4);
  if (op === 0 || op === 1) h.tick(rnd(30000));
  else if (op === 2) h.observe(k, rnd(130));
  else if (op === 3) {
    for (let w = 0; w < 4; w++) tracks[k].held[w] = rnd(3) === 0 ? rnd32() : 0;
    tracks[k].nheld = rnd(4) === 0 ? rnd(3) : 0;
  } else if (op === 4) {
    const n = rnd(4);
    const notes: number[] = [];
    for (let i = 0; i < 4; i++) notes.push(rnd(128));
    tracks[k].seqNotes = notes.slice(0, n);
  } else if (op === 5) {
    configure(k);
    if (rnd(3) === 0) h.forget(k);
    solo = rnd(3) === 0 ? 1 << rnd(4) : 0;
    beat = 11025 + rnd(30000);
  } else {
    const root = rnd(128);
    if (op === 6) {
      const c = h.make(k, root);
      fnv(c.notes.length); fnv(c.root); fnv(c.mask); for (const n of c.notes) fnv(n);
      hashName(tracks[k].chrd, c.root, c.mask);
    } else {
      const c = h.build(k, root);
      fnv(c.notes.length); for (const n of c.notes) fnv(n);
      const l = h.last[k];
      fnv(l.root); fnv(l.mask); fnv(l.gen);
      hashName(tracks[k].chrd, l.root, l.mask);
      builds++;
      if (op === 9) {
        const n2 = c.notes.slice();
        const st = newStrum();
        const first = h.strumBegin(k, n2, c.notes.length, st, 100, beat);
        fnv(first); for (let i = 0; i < c.notes.length; i++) fnv(n2[i]); fnv(st.total); fnv(st.rate);
        if (st.total) {
          let started = first, tm = 0;
          while (started < st.total && tm < 200000) {
            const chunk = 1 + rnd(3000);
            if (rnd(7) === 0) beat = 11025 + rnd(30000);
            tm += chunk; h.strumDue(st, started, chunk, beat);
            while (started < st.total && !h.strumDue(st, started, 0, beat)) { fnv(tm); started++; }
          }
          fnv(st.pos); fnv(st.beat);
        }
      }
    }
  }
}
const ours = `builds ${builds} hash ${H.toString(16).padStart(8, "0")}`;
const gold = readFileSync("tests/harmony-gold.txt", "utf8").trim();
if (ours !== gold) { console.error(`harmony: gold ${gold} ours ${ours}`); process.exit(1); }
console.log(`harmony: ${ours} match Melodee's C`);
