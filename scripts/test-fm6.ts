// Compares the port against reference output of Felucca's fm6_core.c (tests/fm6-gold.txt).
import { readFileSync } from "node:fs";
import { exp2, freq, sin } from "../src/fm6/math";
import { CTL } from "../src/fm6/tables";
import { Op, render } from "../src/fm6/core";

const got: string[] = [];
for (const x of [-100000000, -5000000, 0, 12345678, 50857777, 60000000, 80000000, 100000000, 200000000])
  got.push(`m ${x} ${exp2(x)} ${freq(x)}`);
for (let ph = 0; ph < 1 << 24; ph += 1234567) got.push(`s ${ph} ${sin(ph)}`);
for (let alg = 0; alg < 32; alg++) {
  const ops: Op[] = Array.from({ length: 6 }, (_, k) => ({
    levelIn: (14 << 24) + (k % 3) * (1 << 22) - (k < 3 ? 0 : 1 << 23),
    gainOut: 0,
    phase: k * 100000,
    freq: freq(50857777 + (k + 1) * (1 << 22)),
  }));
  const fb = new Int32Array(2);
  const out = new Int32Array(CTL);
  let sum = 0;
  let last = [0, 0, 0];
  for (let b = 0; b < 8; b++) {
    out.fill(0);
    if (!render(out, ops, alg, fb, 3)) got.push("silent");
    for (const v of out) sum += v;
    last = [out[0], out[17], out[31]];
  }
  got.push(`a ${alg} ${sum} ${last.join(" ")}`);
}
const gold = readFileSync("tests/fm6-gold.txt", "utf8").trim().split("\n");
let bad = 0;
gold.forEach((g, i) => { if (g !== got[i]) { bad++; if (bad < 6) console.log(`MISMATCH\n gold ${g}\n  got ${got[i]}`); } });
console.log(bad ? `FAIL ${bad}/${gold.length}` : `OK ${gold.length} lines match`);
if (bad) process.exit(1);

// ---- note layer: envelopes, LFO, pitch envelope, scaling, patch unpacking ----
import { Note, logFreq } from "../src/fm6/note";
import { Lfo } from "../src/fm6/env";
import { FP, unpack } from "../src/fm6/patch";
import { factoryPatches } from "../src/fm6/library";

const pats: number[][] = JSON.parse(readFileSync("tests/fm6-patches155.json", "utf8"));
let bad2 = 0;
// unpack(pack(v)) must give back the original 155-byte voices
factoryPatches.slice(0, 9).forEach((lp, i) => {
  for (let j = 0; j < 155; j++) if (lp.patch[j] !== pats[i][j]) { bad2++; console.log(`unpack mismatch patch ${i} byte ${j}`); break; }
});
const gold2 = readFileSync("tests/fm6-note-gold.txt", "utf8").trim().split("\n");
pats.forEach((arr, pi) => {
  const p = Uint8Array.from(arr);
  const tr = p[FP.TRNSP];
  const n = new Note();
  const l = new Lfo();
  l.reset(p);
  n.init(p, 60 + tr - 24, 100, true);
  l.key();
  const out = new Int32Array(CTL);
  let sum = 0;
  const marks = [0, 0, 0, 0];
  let doneAt = -1;
  for (let b = 0; b < 200; b++) {
    if (b === 100) n.key(p, false);
    const lv = l.sample();
    const ld = l.delay();
    const lf = logFreq(60 * 16 + (tr - 24) * 16, 0);
    out.fill(0);
    n.compute(p, out, lv, ld, lf, p[FP.ALG], p[FP.FB]);
    let bs = 0;
    for (const v of out) bs += v;
    sum += bs;
    if (b === 0) marks[0] = bs;
    if (b === 50) marks[1] = bs;
    if (b === 99) marks[2] = bs;
    if (b === 150) marks[3] = bs;
    if (doneAt < 0 && n.done(p, p[FP.ALG])) doneAt = b;
  }
  const line = `n ${pi} ${sum} ${marks.join(" ")} ${doneAt}`;
  if (line !== gold2[pi]) { bad2++; console.log(`NOTE MISMATCH\n gold ${gold2[pi]}\n  got ${line}`); }
});
console.log(bad2 ? `NOTE FAIL ${bad2}` : "OK note layer + patch unpack match");

// ---- patch formats, polyphony, sequencer ----
import { buildBankSysex, pack, parseSysex } from "../src/fm6/patch";
import { PolySynth } from "../src/synth/poly";
import { Engine } from "../src/seq/engine";
import { byName } from "../src/fm6/library";

let bad3 = 0;
const check = (ok: boolean, what: string) => { if (!ok) { bad3++; console.log("FAIL", what); } };
// pack/unpack round trip and SysEx bank round trip
check(factoryPatches.every((lp) => unpack(pack(lp.patch)).every((x, i) => x === lp.patch[i])), "pack/unpack round trip");
const bank = buildBankSysex(factoryPatches.map((p) => p.patch));
const back = parseSysex(bank);
check(back.length === 32 && back[3].every((x, i) => x === factoryPatches[3].patch[i]), "sysex bank round trip");
check(bank[bank.length - 1] === 0xf7 && (bank.slice(6, 6 + 4096).reduce((a, b) => a + b, 0) + bank[6 + 4096]) % 128 === 0, "sysex checksum");
// polyphony: more notes than voices must steal, never exceed the voice count, never produce NaN
const poly = new PolySynth(byName("TINE EP").patch, 4);
for (let i = 0; i < 9; i++) poly.noteOn(48 + i * 3);
check(factoryPatches.length === 33 && factoryPatches.every((p) => p.patch.length === 155 && p.name.length > 0), "factory library has 33 sane voices");
check(poly.activeVoices === 4, "voice stealing keeps 4 voices");
const buf = new Float32Array(2048);
poly.render(buf, 0, buf.length);
check(buf.every(Number.isFinite) && buf.some((x) => x !== 0), "poly output finite and non-silent");
// sequencer: 120 BPM, 44.1 kHz -> a 16th is 5513 frames (5512.5 rounded)
import { createEngine } from "../src/seq/engine";
import { defaultSong, emptyPattern, sanitizeSong, Song } from "../src/seq/song";
import { factoryInstrument as patchFor } from "../src/instruments";
const mini: Song = {
  bpm: 120, swing: 0,
  tracks: [{ patch: "PLUCK", mute: false }, { patch: "INIT", mute: true }, { patch: "INIT", mute: true }, { patch: "INIT", mute: true }],
  patterns: [emptyPattern("A", 4), emptyPattern("B", 8)],
  arrangement: [0, 1, 0],
};
mini.patterns[0].steps[0][0] = { notes: [60] };
mini.patterns[1].steps[0][3] = { notes: [64], vel: 80, gate: 2 };
const eng = createEngine(44100, mini, patchFor);
const seen: string[] = [];
eng.onStep = (p, st, ap) => seen.push(`${p}.${st}@${ap}`);
eng.play();
const chunk = new Float32Array(128);
for (let i = 0; i < Math.ceil(88200 / 128); i++) eng.render(chunk);
check(eng.stepIndex === 17, `sequencer step count after 2 s (got ${eng.stepIndex})`);
// arrangement 0(4) 1(8) 0(4) then wraps: steps 0-3 are pattern 0, 4-11 pattern 1, 12-15 pattern 0, 16 wraps to pattern 0
check(seen.slice(0, 5).join() === "0.0@0,0.1@0,0.2@0,0.3@0,1.0@1", `song order (got ${seen.slice(0, 5)})`);
check(seen[12] === "0.0@2" && seen[16] === "0.0@0", `arrangement loop (got ${seen[12]}, ${seen[16]})`);
// pattern mode loops one pattern
const eng2 = createEngine(44100, mini, patchFor);
eng2.mode = "pattern"; eng2.patternIndex = 1;
const seen2: string[] = [];
eng2.onStep = (p, st) => seen2.push(`${p}.${st}`);
eng2.play();
for (let i = 0; i < Math.ceil(5513 * 10 / 128); i++) eng2.render(chunk);
check(seen2.slice(6, 10).join() === "1.6,1.7,1.0,1.1", `pattern loop (got ${seen2.slice(6, 10)})`);
// live song replacement keeps playing, and a corrupt song is rejected
eng.setSong(defaultSong());
for (let i = 0; i < 20; i++) eng.render(chunk);
check(sanitizeSong({}) === null && sanitizeSong(JSON.parse(JSON.stringify(defaultSong())))?.patterns.length === 4, "song sanitize");
eng.stop();
// algorithm graphs decoded from the table match the DX7 diagrams
import { algoGraph, envPoints } from "../src/ui/algo";
const has = (g: ReturnType<typeof algoGraph>, a: number, b: number) => g.edges.some(([x, y]) => x === a && y === b);
const g1 = algoGraph(1), g5 = algoGraph(5), g22 = algoGraph(22), g32 = algoGraph(32);
check(g1.carriers.join() === "1,3" && has(g1, 2, 1) && has(g1, 6, 5) && has(g1, 5, 4) && has(g1, 4, 3) && g1.feedback === 6, "algorithm 1 graph");
check(g5.carriers.join() === "1,3,5" && has(g5, 2, 1) && has(g5, 4, 3) && has(g5, 6, 5) && g5.edges.length === 3, "algorithm 5 graph");
check(g22.carriers.join() === "1,3,4,5" && has(g22, 6, 3) && has(g22, 6, 4) && has(g22, 6, 5) && has(g22, 2, 1), "algorithm 22 graph");
check(g32.carriers.length === 6 && g32.edges.length === 0, "algorithm 32 graph");
check(g1.level[6] === 3 && g1.level[3] === 0, "algorithm 1 stack depth");
check(envPoints([99, 50, 50, 50], [99, 75, 0, 0], 200, 70).split(" ").length === 6, "envelope polyline");
// every factory instrument (FM6 voices and engine presets) plays: finite, audible, within range, and releases
import { factoryEntries } from "../src/instruments";
import { makeSynth } from "../src/synth/synth";
for (const e of factoryEntries) {
  const syn = makeSynth(e.instrument, 4);
  const out = new Float32Array(44100);
  syn.noteOn(e.note, 100);
  syn.render(out, 0, 22050);
  syn.noteOff(e.note);
  syn.render(out, 22050, 22050);
  let pk = 0, bad = 0;
  for (const x of out) { if (!Number.isFinite(x)) bad++; pk = Math.max(pk, Math.abs(x)); }
  if (bad || pk < 0.003 || pk > 4) { bad3++; console.log(`FAIL instrument ${e.id}: peak ${pk.toFixed(3)} nonfinite ${bad}`); }
}
check(factoryEntries.length === 33 + 37 + 9 + 13 + 9 + 8 + 4 + 3, `factory entries (got ${factoryEntries.length}; 4 of them Melodee drum kits, 3 acoustic)`);
console.log(bad3 ? `FAIL ${bad3}` : "OK formats, polyphony, sequencer");
process.exit(bad2 + bad3 ? 1 : 0);
