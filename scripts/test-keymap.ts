// Checks the key map (QNT modes, scales, microtonal scales) against a hash of Melodee's seq.c / microtonal.h compiled in a harness (tests/keymap-gold.txt).
import { readFileSync } from "node:fs";
import { KeyMapParams, keyNote, microActive, microPitch, microScale, midiNote, scaleCount, scaleMask, scaleNotePeriod } from "../src/synth/keymap";

let h = 2166136261;
const fnv = (v: number): void => {
  h = Math.imul(h ^ (v & 255), 16777619) >>> 0;
  h = Math.imul(h ^ ((v >>> 8) & 255), 16777619) >>> 0;
};
let n = 0;
for (let scale = 0; scale < 70; scale++)
  for (let quant = 0; quant < 5; quant++)
    for (let root = 0; root < 12; root += 5)
      for (let trans = -7; trans <= 7; trans += 7)
        for (let oct = -1; oct <= 1; oct++)
          for (let mpc = 1; mpc <= 3; mpc += 2) {
            const p: KeyMapParams = { scale, quant, root, trans, octave: oct, mpcdeg: mpc };
            const track = (root + oct + 1) & 3;
            for (let k = 0; k < 27; k++) fnv(keyNote(p, k));
            for (let m = 0; m < 128; m += 3) fnv(midiNote(p, m, track));
            if (microScale(p)) for (let note = 0; note < 128; note += 7) { const mp = microPitch(p, note); fnv(mp); fnv(mp >> 16); }
            fnv(scaleMask(p)); fnv(scaleCount(p)); fnv(scaleNotePeriod(p)); fnv(microActive(p) ? 1 : 0);
            n++;
          }
const ours = `${n} configs, hash ${h.toString(16).padStart(8, "0")}`;
const gold = readFileSync("tests/keymap-gold.txt", "utf8").trim();
if (ours !== gold) { console.error(`keymap: gold ${gold} ours ${ours}`); process.exit(1); }
console.log(`keymap: ${ours} match Melodee's C`);
