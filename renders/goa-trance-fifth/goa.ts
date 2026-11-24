// Beethoven's Fifth motto as a slowly mutating Goa trance: a rolling bass, a looping ostinato, a 7-step cycle against the 16-step bar, long filter sweeps.
import { build, mix, renderBuf, writeWav } from "../beethoven-fifth-techno/lib";
import { factoryInstrument } from "../../src/instruments";
import { Step } from "../../src/seq/song";
import { Instrument } from "../../src/synth/synth";

const BARS = 72, N = BARS * 16;
const h = (a: number, b: number): number => ((Math.imul(a + 1, 73856093) ^ Math.imul(b + 7, 19349663)) >>> 0) % 1000 / 1000;
const SC = [0, 2, 3, 5, 7, 8, 10];
/** a note moved by `d` degrees of C minor */
const move = (m: number, d: number): number => {
  let o = Math.floor(m / 12), i = SC.indexOf(m % 12);
  if (i < 0) return m;
  i += d;
  while (i < 0) { i += 7; o--; }
  while (i > 6) { i -= 7; o++; }
  return o * 12 + SC[i];
};
const blk = (bar: number) => Math.floor(bar / 8), inb = (bar: number) => bar % 8;
const empty = (): Step[] => Array<Step>(N).fill(null);
const put = (a: Step[], i: number, notes: number[], vel: number, gate: number): void => { if (i >= 0 && i < N) a[i] = { notes, vel, gate }; };

// which layers play in which 8-bar block
const kickOn = (b: number, k: number) => [0, 1, 2, 4, 5, 7].includes(b) || (b === 3 && k < 4) || (b === 8 && k < 4);
const hatOn = (b: number, k: number) => !(b === 8 && k >= 4);
const bassOn = (b: number, k: number) => (b === 0 ? k >= 2 : b === 8 ? k < 4 : true);
const leadOn = (b: number) => [1, 2, 4, 5, 7].includes(b);
const wireOn = (b: number) => [4, 5, 7].includes(b);
const resoOn = (b: number) => [2, 4, 5, 6, 7].includes(b);
const bellOn = (b: number) => [2, 5, 6, 7].includes(b);
const glitchOn = (b: number, k: number) => b === 3 || b === 6 || (b === 8 && k >= 4);
const windOn = (b: number, k: number) => (b === 3 || b === 6) && k >= 4;

// drums
const drums = empty();
for (let bar = 0; bar < BARS; bar++) {
  const b = blk(bar), k = inb(bar), o = bar * 16;
  for (let j = 0; j < 4; j++) {
    if (kickOn(b, k)) put(drums, o + j * 4, [36], 120, 0.8);
    if (hatOn(b, k)) {
      put(drums, o + j * 4 + 2, [46], 82, 0.8);
      if (b >= 1) put(drums, o + j * 4 + 3, [42], 50, 0.6);
    }
  }
  if (b >= 4 && b !== 6 && (k === 3 || k === 7) && kickOn(b, k)) for (let i = 12; i < 16; i++) put(drums, o + i, [38], 70 + (i - 12) * 10, 0.7); // a snare roll into the next phrase
  if (b === 3 && k >= 4 || b === 6 && k >= 4) put(drums, o, [39], 60, 0.7);
}

// bass: the motto's G Eb F D as the root, two bars each; a rolling 16th line around the kick
const roots = [7, 7, 3, 3, 5, 5, 2, 2];
const bass = empty();
for (let bar = 0; bar < BARS; bar++) {
  const b = blk(bar), k = inb(bar), o = bar * 16;
  if (!bassOn(b, k)) continue;
  let r = 36 + roots[(bar + (b >= 5 ? 2 : 0)) % 8]; if (r >= 43) r -= 12;
  for (let j = 0; j < 4; j++) for (let s = 1; s < 4; s++) {
    const x = h(bar * 4 + j, s);
    let n = r;
    if (s === 3 && x < 0.15 + 0.05 * b) n = r + 12;
    else if (s === 2 && x > 0.93 - 0.02 * b) n = r + 7;
    if (x > 0.97 && b >= 3) continue; // an occasional gap
    put(bass, o + j * 4 + s, [n], s === 1 ? 108 : s === 2 ? 88 : 100, 0.7);
  }
}

// the ostinato: "g g g eb", "f f f d" in sixteenths, mutating bit by bit
const lead = empty();
for (let bar = 0; bar < BARS; bar++) {
  const b = blk(bar), k = inb(bar), o = bar * 16;
  if (!leadOn(b)) continue;
  const cell = bar % 2 ? [65, 65, 65, 62] : [67, 67, 67, 63];
  const p = 0.05 * (b + (k >= 4 ? 1 : 0));
  for (let i = 0; i < 16; i++) {
    let n = cell[i % 4] + (b >= 5 ? 12 : 0);
    const x = h(bar, i + 100);
    if (x < p) n += 12;
    else if (x < 2 * p) n = move(n, h(bar, i) < 0.5 ? 1 : -1);
    else if (x > 1 - p * 0.7) continue;
    put(lead, o + i, [n], i % 4 === 3 ? 110 : 92, i % 4 === 3 ? 0.9 : 0.55);
  }
}

// the motto itself, long and exposed, a rising sequence through the blocks
const wire = empty();
for (let bar = 0; bar < BARS; bar += 4) {
  const b = blk(bar);
  if (!wireOn(b)) continue;
  const up = b === 4 ? 0 : b === 5 ? 1 : 2, o = bar * 16;
  const A = move(79, up), Bn = move(75, up), C = move(77, up), D = move(74, up);
  for (const s of [2, 4, 6]) put(wire, o + s, [A], 80, 1.6);
  put(wire, o + 8, [Bn], 92, 7);
  for (const s of [2, 4, 6]) put(wire, o + 16 + s, [C], 80, 1.6);
  put(wire, o + 24, [D], 92, 14);
}

// a 7-step cycle against the 16-step bar
const cyc = [79, 75, 77, 74, 79, 70, 77];
const reso = empty();
for (let i = 0; i < N; i++) {
  const bar = Math.floor(i / 16), b = blk(bar);
  if (!resoOn(b)) continue;
  let n = cyc[i % 7];
  if (b >= 5 && h(bar, i) < 0.2) n = move(n, 1);
  if (h(bar, i + 50) < 0.1) continue;
  put(reso, i, [n - (b === 6 ? 12 : 0)], i % 7 === 0 ? 104 : 86, 0.6);
}

// ring-modulated bell hits
const bell = empty();
for (let bar = 0; bar < BARS; bar++) {
  const b = blk(bar), o = bar * 16;
  if (!bellOn(b) || bar % 2 === 0) continue;
  put(bell, o + 6, [79], 96, 5);
  if (b >= 6) put(bell, o + 14, [86], 90, 3);
}

// glitch and the wind riser in the breakdowns
const glitch = empty();
for (let bar = 0; bar < BARS; bar++) {
  const b = blk(bar), k = inb(bar), o = bar * 16;
  if (!glitchOn(b, k)) continue;
  for (let i = 0; i < 16; i++) if (h(bar, i + 300) < 0.38) put(glitch, o + i, [[55, 58, 62, 67][Math.floor(h(bar, i + 9) * 4)]], 85, 0.5);
}
const wind = empty();
for (let bar = 0; bar < BARS; bar++) if (windOn(blk(bar), inb(bar)) && inb(bar) === 4) put(wind, bar * 16, [67], 100, 62);

if (process.env.SOLO === "bass") for (const a of [drums, lead, wire, reso, bell, glitch, wind]) a.fill(null);
const fx = { dtime: 10, dfdbk: 66, dcolor: 55, dmix: 90, rtype: 2, rsize: 95, rdamp: 50 };
// the sweeps: slow free-running LFOs on the filter (rate 0 is a 20 s cycle, the synced ones 4 and 2 bars)
const sweep = (rate: number, flt: number, shp = 0, sync = 0, phase = 0) => ({ rate, wave: 1, trig: 1, phase, sync, ldFlt: flt, ldShp: shp });
const A = build(142, 0, 32, [
  { patch: "DRUM/DRUM KIT", mix: { level: 118, reverb: 8 }, steps: drums },
  { patch: "ANALOG/ACID", mix: { level: 112, dist: 18, itype: 3, imix: 40, ia: 50, ib: 70, ic: 80, reverb: 4 }, mod: sweep(0, 56, 0, 0, 0), steps: bass },
  { patch: "TRIO/SYNC LEAD", mix: { level: 92, pan: 12, delay: 60, reverb: 25 }, mod: sweep(0, 40, 45, 1, 40), steps: lead },
  { patch: "PHASE/WIRE", mix: { level: 58, pan: -14, delay: 85, reverb: 65 }, mod: { rate: 3, wave: 1, trig: 1, sync: 2, pol: 1, ldFlt: -58 }, steps: wire },
], fx);
const B = build(142, 0, 32, [
  { patch: "PHASE/RESO", mix: { level: 100, pan: -20, delay: 65, reverb: 30 }, mod: sweep(0, 50, 0, 0, 64), steps: reso },
  { patch: "TRIO/RING BELL", mix: { level: 90, pan: 24, delay: 80, reverb: 50 }, steps: bell },
  { patch: "GRAIN/GLITCH", mix: { level: 96, pan: 6, delay: 55, reverb: 30 }, steps: glitch },
  { patch: "NOISE/WIND", mix: { level: 90, reverb: 40 }, mod: sweep(0, 60, 0, 1), steps: wind },
], fx);
const inst = (id: string): Instrument => {
  const i = factoryInstrument(id);
  if (id === "ANALOG/ACID" && i.kind === "engine") return { ...i, vp: { voice: 1, glide: 3, glmode: 1, prio: 0, alloc: 0, detune: 14, spread: 0 } };
  return i;
};
const out = mix([{ buf: renderBuf(A, 6, inst), gain: 1.5 }, { buf: renderBuf(B, 6, inst), gain: 0.6 }]);
for (const ch of [out.l, out.r]) for (let i = 0; i < ch.length; i++) ch[i] = Math.tanh(ch[i] * 1.4);
console.log("goa:", writeWav(process.argv[2], out).toFixed(1), "s");
