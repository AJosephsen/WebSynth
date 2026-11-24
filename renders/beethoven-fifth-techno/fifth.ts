// Beethoven's Fifth, first movement: the actual notes of the public-domain score (Mutopia / Breitkopf MIDI), played by techno voices.
import { build, line, mix, renderBuf, writeWav } from "./lib";
import { factoryInstrument } from "../../src/instruments";
import { Step } from "../../src/seq/song";
import { Instrument } from "../../src/synth/synth";
import { MS_LFO, MD_CUT } from "../../src/mod/mod";
import score from "./score.json";

type Ev = [number, number[], number];
interface Sec { name: string; steps: number; bars: number; voices: Record<string, Ev[][]>; bass: (number | null)[] }
const secs = score.sections as unknown as Sec[];
const CAP = 16;
const slots = (...s: { src: number; dst: number; amt: number }[]) => [...s, ...Array.from({ length: 4 - s.length }, () => ({ src: 0, dst: 0, amt: 0 }))];
const NN = ["c", "c#", "d", "eb", "e", "f", "f#", "g", "ab", "a", "bb", "b"];
const nn = (m: number) => `${NN[m % 12]}${Math.floor(m / 12) - 1}`;

/** One slot's notes of a section as grid steps. */
function steps(sec: Sec, slot: number): Step[] {
  const out: Step[] = Array<Step>(sec.steps).fill(null);
  const m = new Map<number, Ev>();
  for (const list of sec.voices[String(slot)] ?? []) for (const [i, n, d] of list) { const o = m.get(i); m.set(i, o ? [i, [...new Set([...o[1], ...n])], Math.max(o[2], d)] : [i, n, d]); }
  const keys = [...m.keys()].sort((a, b) => a - b);
  keys.forEach((i, k) => {
    const [, n, d] = m.get(i)!;
    const gap = k + 1 < keys.length ? keys[k + 1] - i : d;
    const len = Math.max(1, Math.min(d, gap, CAP));
    out[i] = { notes: n, vel: len >= 4 ? 118 : 104, gate: len > 1 ? len * 0.95 : 0.8 };
  });
  return out;
}
const perBar = (sec: Sec, f: (bar: number) => string[]): Step[] => line(Array.from({ length: sec.bars }, (_, b) => f(b)).flat());

const GR = ["k+h/70", "r", "h/60", "r", "k+h/70", "r", "h/60", "o/50"], GR2 = ["k+h/70", "r", "h/60", "r", "k+h/70", "r", "h/60", "s/60"];
const DR = ["k+h", "r", "h", "c", "k+h", "r", "h", "o"], CR = ["k+h+c", "r", "h", "c", "k+h", "r", "h", "o"];
const REST = Array(8).fill("r"), HAT = ["r", "r", "h/50", "r", "r", "r", "h/50", "r"], KICKS = ["k", "r", "k", "r", "k", "r", "k", "k"];
function drums(sec: Sec): string[] {
  switch (sec.name) {
    case "intro": return [...REST, ...REST, ...REST, ...REST, ...KICKS];
    case "dial": return Array.from({ length: sec.bars }, (_, b) => (b >= 12 ? DR : b % 2 ? GR2 : GR)).flat();
    case "seq": return Array.from({ length: sec.bars }, (_, b) => (b === 0 ? CR : DR)).flat();
    case "horn": return Array.from({ length: sec.bars }, (_, b) => (b < 4 ? HAT : b % 2 ? GR2 : GR)).flat();
    case "dev": return Array.from({ length: sec.bars }, (_, b) => (b < 8 ? (b % 2 ? GR2 : GR) : b === 8 ? CR : DR)).flat();
    case "ff": return Array.from({ length: sec.bars }, (_, b) => (b === 0 ? CR : DR)).flat();
    default: return Array.from({ length: sec.bars }, (_, b) => (b === 0 ? CR : b < 18 ? DR : b === 18 ? ["k+c", "r", "r", "r", "r", "r", "r", "r"] : REST)).flat();
  }
}
const noBass = new Set(["intro", "horn"]);
function acid(sec: Sec): string[] {
  return Array.from({ length: sec.bars }, (_, b) => {
    const r = sec.bass[b];
    if (r === null || r === undefined || (noBass.has(sec.name) && b < 6) || (sec.name === "coda" && b >= 18)) return REST;
    const n = nn(36 + (r % 12)), hi = nn(48 + (r % 12));
    return [`${n}/110`, "r", `${n}/80`, `${n}/100`, "r", `${hi}/118`, `${n}/100`, "r"];
  }).flat();
}
function stabs(sec: Sec): string[] {
  const on = (b: number) => (sec.name === "seq" && b > 0) || (sec.name === "dev" && b >= 8) || (sec.name === "ff" && b > 0) || (sec.name === "coda" && b > 0 && b < 18);
  return Array.from({ length: sec.bars }, (_, b) => {
    const r = sec.bass[b];
    if (r === null || r === undefined || !on(b)) return REST;
    const c = `${nn(60 + (r % 12))}+${nn(67 + (r % 12))}`;
    return ["r", "r", `${c}:1/92`, "r", "r", `${c}:1/80`, "r", "r"];
  }).flat();
}

const cat = <T,>(f: (s: Sec) => T[]): T[] => secs.flatMap(f);
const lead = (slot: number) => cat((s) => steps(s, slot));
const fx = { dtime: 10, dfdbk: 58, dcolor: 55, dmix: 85, rtype: 2, rsize: 90, rdamp: 50 };
const A = build(130, 0, 32, [
  { patch: "DRUM/DRUM KIT", mix: { level: 112, reverb: 12 }, steps: cat((s) => line(drums(s))) },
  { patch: "ANALOG/ACID", mix: { level: 108, dist: 20, itype: 3, imix: 40, ia: 50, ib: 70, ic: 80, reverb: 6 }, mod: { rate: 50, slots: slots({ src: MS_LFO, dst: MD_CUT, amt: 25 }) }, steps: cat((s) => line(acid(s))) },
  { patch: "ANALOG/RAVE", mix: { level: 86, pan: 14, chorus: 30, delay: 45, reverb: 25 }, steps: cat((s) => line(stabs(s))) },
], fx);
const C = build(130, 0, 32, [
  { patch: "ANALOG/BRASS", mix: { level: 110, pan: -6, dist: 30, delay: 55, reverb: 28 }, steps: lead(0) },
], fx);
const B = build(130, 0, 32, [
  { patch: "ANALOG/SAW LEAD", mix: { level: 108, pan: 16, dist: 15, delay: 55, reverb: 25 }, steps: lead(1) },
  { patch: "LOFI/PULSE LD", mix: { level: 90, pan: -16, delay: 50, reverb: 18 }, steps: lead(2) },
  { patch: "LOFI/STEP LEAD", mix: { level: 100, pan: 6, delay: 60, reverb: 25 }, steps: lead(3) },
  { patch: "PHASE/WIRE", mix: { level: 96, pan: -6, dist: 12, delay: 45, reverb: 20 }, steps: lead(4) },
], fx);
const inst = (id: string): Instrument => {
  const i = factoryInstrument(id);
  if (id === "ANALOG/SAW LEAD" && i.kind === "engine" && i.vp) return { ...i, vp: { ...i.vp, voice: 0, glide: 0 } };
  if (id === "ANALOG/ACID" && i.kind === "engine") return { ...i, vp: { voice: 1, glide: 4, glmode: 1, prio: 0, alloc: 0, detune: 12, spread: 0 } };
  return i;
};
const out = mix([{ buf: renderBuf(A, 6, inst), gain: 2.6 }, { buf: renderBuf(B, 6, inst), gain: 0.3 }, { buf: renderBuf(C, 6, inst), gain: 0.3 }]);
// a soft limiter to bring the whole up without clipping
for (const ch of [out.l, out.r]) for (let i = 0; i < ch.length; i++) ch[i] = Math.tanh(ch[i] * 1.4);
console.log("fifth-score:", writeWav(process.argv[2], out).toFixed(1), "s");
