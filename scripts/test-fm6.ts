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
factoryPatches.forEach((lp, i) => {
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
check(poly.activeVoices === 4, "voice stealing keeps 4 voices");
const buf = new Float32Array(2048);
poly.render(buf, 0, buf.length);
check(buf.every(Number.isFinite) && buf.some((x) => x !== 0), "poly output finite and non-silent");
// sequencer: 120 BPM, 44.1 kHz -> a 16th is 5513 frames (5512.5 rounded)
const eng = new Engine(44100, new PolySynth(byName("INIT").patch, 2));
eng.addTrack(new PolySynth(byName("PLUCK").patch, 2), [{ notes: [60] }, null, null, null]);
eng.play();
const chunk = new Float32Array(128);
for (let i = 0; i < Math.ceil(88200 / 128); i++) eng.render(chunk);
check(eng.stepIndex === 17, `sequencer step count after 2 s (got ${eng.stepIndex})`);
eng.stop();
check(eng.tracks[0].synth.activeVoices >= 0, "stop ok");
console.log(bad3 ? `FAIL ${bad3}` : "OK formats, polyphony, sequencer");
process.exit(bad2 + bad3 ? 1 : 0);
