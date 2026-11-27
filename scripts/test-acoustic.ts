// The acoustic snare and toms: every hit sounds, stays finite and ends; a snare has its wires, a harder hit is louder and has a higher pitch fall; toms are pitched by note.
import { AcousticDrums } from "../src/drum/acoustic";
import { factoryInstrument } from "../src/instruments";
import { makeSynth } from "../src/synth/synth";

let fails = 0;
const check = (ok: boolean, msg: string): void => { if (!ok) { fails++; console.error("FAIL " + msg); } else console.log("OK " + msg); };
const hit = (note: number, vel: number, params = [16, 64, 70, 64, 90, 80, 64, 40], secs = 1.5): Float32Array => {
  const d = new AcousticDrums(params);
  d.noteOn(note, vel);
  const out = new Float32Array(Math.round(44100 * secs));
  for (let i = 0; i < out.length; i += 64) d.render(out, i, Math.min(64, out.length - i));
  return out;
};
const peak = (x: Float32Array): number => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const rms = (x: Float32Array, a: number, b: number): number => { let s = 0; for (let i = a; i < b; i++) s += x[i] ** 2; return Math.sqrt(s / (b - a)); };
/** The strongest frequency (Hz) in x[a..b] by zero crossings. */
const zc = (x: Float32Array, a: number, b: number): number => { let c = 0; for (let i = a + 1; i < b; i++) if (x[i - 1] < 0 !== x[i] < 0) c++; return (c / 2) / ((b - a) / 44100); };
for (const note of [37, 38, 40, 41, 43, 45, 47, 48, 50]) {
  const y = hit(note, 110);
  check(peak(y) > 0.15 && peak(y) < 1 && y.every(Number.isFinite), `note ${note} sounds (peak ${peak(y).toFixed(2)})`);
}
const tom = hit(41, 100, undefined, 3), hi = hit(50, 100, undefined, 3);
check(zc(tom, 2000, 9000) < zc(hi, 2000, 9000), `a low tom is lower than a high tom (${zc(tom, 2000, 9000).toFixed(0)} vs ${zc(hi, 2000, 9000).toFixed(0)} Hz)`);
check(rms(tom, 100000, 110000) < rms(tom, 4000, 14000) * 0.3, "a tom decays");
const soft = hit(38, 40), loud = hit(38, 120);
check(peak(loud) > peak(soft) * 1.3, `a harder snare hit is louder (${peak(soft).toFixed(2)} -> ${peak(loud).toFixed(2)})`);
const dry = hit(38, 110, [16, 64, 70, 64, 0, 80, 64, 40]), wired = hit(38, 110, [16, 64, 70, 64, 127, 80, 64, 40]);
check(rms(wired, 6000, 20000) > rms(dry, 6000, 20000) * 1.25, `the wires add sound after the head has gone (${rms(dry, 6000, 20000).toFixed(3)} -> ${rms(wired, 6000, 20000).toFixed(3)})`);
const fresh = hit(45, 100, undefined, 4);
check(peak(fresh.subarray(44100 * 3)) < 1e-3, "and a hit ends (silent after 3 s)");
const s = makeSynth(factoryInstrument("DRUM/ACOUSTIC"));
s.noteOn(38, 100); const o = new Float32Array(4096); s.render(o, 0, 4096);
check(peak(o) > 0.05, "the factory ACOUSTIC kit plays through makeSynth");
process.exit(fails ? 1 : 0);
