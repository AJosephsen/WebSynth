// The demo songs build, use existing instruments, survive sanitize and render audible, finite audio.
import { factoryEntries, factoryInstrument } from "../src/instruments";
import { createEngine } from "../src/seq/engine";
import { sanitizeSong } from "../src/seq/song";
import { demoSongs } from "../src/seq/songs";

let fails = 0;
const check = (ok: boolean, msg: string): void => { if (!ok) { fails++; console.error("FAIL " + msg); } };
const ids = new Set(factoryEntries.map((e) => e.id));
for (const d of demoSongs) {
  const s = d.build();
  check(s.tracks.every((t) => ids.has(t.patch)), `${d.id}: every patch exists`);
  const r = sanitizeSong(JSON.parse(JSON.stringify(s)));
  check(!!r && r.patterns.length === s.patterns.length && r.arrangement.length === s.arrangement.length, `${d.id}: sanitize keeps the song`);
  const e = createEngine(44100, s, factoryInstrument);
  const bars = s.arrangement.reduce((t, p) => t + s.patterns[p].length / 16, 0);
  const frames = Math.floor(((44100 * 60) / s.bpm) * 4 * Math.min(bars, 8));
  const out = new Float32Array(frames);
  e.play();
  const chunk = new Float32Array(1024);
  let peak = 0, sum = 0, finite = true;
  for (let i = 0; i < frames; i += 1024) {
    const n = Math.min(1024, frames - i);
    const c = chunk.subarray(0, n);
    e.render(c);
    for (let k = 0; k < n; k++) { const x = c[k]; if (!Number.isFinite(x)) finite = false; peak = Math.max(peak, Math.abs(x)); sum += x * x; out[i + k] = x; }
  }
  const rms = Math.sqrt(sum / frames);
  console.log(`${d.id.padEnd(9)} ${bars} bars, ${s.patterns.length} patterns, peak ${peak.toFixed(2)}, rms ${rms.toFixed(3)}`);
  check(finite && peak > 0.05 && peak <= 1 && rms > 0.01, `${d.id}: finite, audible, within range`);
}
if (fails) process.exit(1);
console.log("OK demo songs");
